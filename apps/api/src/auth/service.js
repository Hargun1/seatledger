import { randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_SECONDS, digest, newToken, csrfFor } from './security.js';
import { HttpError } from '../http-error.js';

const publicUser=row=>({id:row.id,email:row.email,displayName:row.display_name,role:row.system_role});
async function transaction(pool,work) {
  const db=await pool.connect();
  try { await db.query('BEGIN'); const result=await work(db); await db.query('COMMIT'); return result; }
  catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
async function issueSession(db,user,config,oldRaw) {
  if(oldRaw) await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL',[digest(oldRaw)]);
  const raw=newToken(), csrfToken=csrfFor(raw,config.AUTH_SECRET);
  const session=(await db.query(`INSERT INTO sessions (user_id,token_hash,csrf_token_hash,expires_at)
    VALUES ($1,$2,$3,clock_timestamp()+($4::integer*interval '1 second')) RETURNING id,expires_at`,[user.id,digest(raw),digest(csrfToken),SESSION_SECONDS])).rows[0];
  return {raw,user:publicUser(user),csrfToken,expiresAt:session.expires_at,sessionId:session.id};
}
async function audit(db,userId,action,entityId,operationId=randomUUID()) {
  await db.query(`INSERT INTO audit_events (operation_id,actor_kind,actor_user_id,action,entity_type,entity_id)
    VALUES ($1,'USER',$2,$3,'system',$4) ON CONFLICT (operation_id,action,entity_type,entity_id) DO NOTHING`,[operationId,userId,action,entityId]);
}
export async function register(pool,config,input,oldRaw) {
  const hash=await hashPassword(input.password);
  try {
    return await transaction(pool,async db=>{
      const user=(await db.query(`INSERT INTO users (email,display_name,password_hash) VALUES ($1,$2,$3)
        RETURNING id,email,display_name,system_role`,[input.email,input.displayName,hash])).rows[0];
      const session=await issueSession(db,user,config,oldRaw);
      await audit(db,user.id,'auth.register',user.id);
      return session;
    });
  } catch(error) {
    if(error.code==='23505' && error.constraint==='users_email_key') throw new HttpError(409,'ACCOUNT_EXISTS');
    throw error;
  }
}
export async function login(pool,config,input,oldRaw) {
  const user=(await pool.query('SELECT id,password_hash,status FROM users WHERE email=$1',[input.email])).rows[0];
  const matched=await verifyPassword(input.password,user?.password_hash);
  if(!matched || !user || user.status!=='ACTIVE') throw new HttpError(401,'INVALID_CREDENTIALS');
  return transaction(pool,async db=>{
    // Hash outside locks; recheck credential/account after taking a short user
    // lock so a concurrent disable/password change cannot issue a stale session.
    const current=(await db.query('SELECT id,email,display_name,system_role,password_hash,status FROM users WHERE id=$1 FOR SHARE',[user.id])).rows[0];
    if(!current || current.status!=='ACTIVE' || current.password_hash!==user.password_hash) throw new HttpError(401,'INVALID_CREDENTIALS');
    const session=await issueSession(db,current,config,oldRaw);
    await audit(db,user.id,'auth.login',session.sessionId);
    return session;
  });
}
export async function readSession(pool,config,raw) {
  if(!raw) throw new HttpError(401,'AUTH_REQUIRED');
  const row=(await pool.query(`SELECT s.id AS session_id,s.expires_at,s.csrf_token_hash,u.id,u.email,u.display_name,u.system_role
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='ACTIVE'`,[digest(raw)])).rows[0];
  if(!row) throw new HttpError(401,'AUTH_REQUIRED');
  const csrfToken=csrfFor(raw,config.AUTH_SECRET);
  if(!timingSafeEqual(digest(csrfToken),row.csrf_token_hash)) throw new HttpError(401,'AUTH_REQUIRED');
  return {user:publicUser(row),sessionId:row.session_id,expiresAt:row.expires_at,csrfToken,csrfHash:row.csrf_token_hash};
}
export async function logout(pool,session,all=false) {
  await transaction(pool,async db=>{
    // Consistent user-before-session order also avoids audit FK lock inversion.
    await db.query(`SELECT id FROM users WHERE id=$1 ${all?'FOR UPDATE':'FOR SHARE'}`,[session.user.id]);
    const result=all
      ? await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL',[session.user.id])
      : await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[session.sessionId,session.user.id]);
    if(result.rowCount) await audit(db,session.user.id,all?'auth.logout_all':'auth.logout',session.sessionId,session.sessionId);
  });
}
