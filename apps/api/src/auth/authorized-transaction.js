import { readSession } from './service.js';
import { HttpError } from '../http-error.js';

// Authorization and business writes share one checked-out connection. Recheck
// after locks so logout/demotion cannot race between a gate and its write.
export async function withAuthorizedSession(pool, config, raw, work, { exclusiveActor = false } = {}) {
  const initial = await readSession(pool, config, raw);
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT set_config($1,$2,true)', ['lock_timeout', '1500ms']);
    // Same user-before-session order as authentication/revocation.
    await db.query(exclusiveActor ? 'SELECT id FROM users WHERE id=$1 FOR UPDATE' : 'SELECT id FROM users WHERE id=$1 FOR SHARE', [initial.user.id]);
    await db.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE', [initial.sessionId]);
    const session = await readSession(db, config, raw);
    const result = await work(db, session);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    if (['55P03', '40P01', '40001'].includes(error.code)) throw new HttpError(503, 'ACCESS_BUSY');
    throw error;
  } finally { db.release(); }
}
