import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../apps/api/src/http-error.js';

export function requireDevelopmentAdmin(env, email) {
  if (!['development', 'test'].includes(env.NODE_ENV ?? 'development') || env.ALLOW_DEV_ADMIN !== 'true') {
    throw new HttpError(403, 'DEVELOPMENT_ADMIN_DISABLED');
  }
  const parsed = z.string().trim().toLowerCase().max(254).pipe(z.email()).safeParse(email);
  if (!parsed.success) throw new HttpError(400, 'INVALID_EMAIL');
  return parsed.data;
}

export async function grantDevelopmentAdmin(pool, env, email) {
  const normalized = requireDevelopmentAdmin(env, email); // Before any connection.
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT set_config($1,$2,true)', ['lock_timeout', '1500ms']);
    const user = (await db.query('SELECT id,status,system_role FROM users WHERE email=$1 FOR UPDATE', [normalized])).rows[0];
    if (!user || user.status !== 'ACTIVE') throw new HttpError(404, 'ACCOUNT_NOT_ELIGIBLE');
    if (user.system_role === 'ADMIN') { await db.query('COMMIT'); return { changed: false }; }
    await db.query("UPDATE users SET system_role='ADMIN' WHERE id=$1", [user.id]);
    await db.query(`INSERT INTO audit_events (operation_id,actor_kind,action,entity_type,entity_id)
      VALUES ($1,'SYSTEM','dev.admin_granted','system',$2)`, [randomUUID(), user.id]);
    await db.query('COMMIT');
    return { changed: true };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
