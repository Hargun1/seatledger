import { createHmac } from 'node:crypto';
import { HttpError } from '../http-error.js';

export const defaultLimits=Object.freeze({loginIp:30,loginEmail:8,registerIp:10});
export async function consumeAuthLimit(pool,secret,action,value,limit,seconds) {
  const hash=createHmac('sha256',Buffer.from(secret,'hex')).update(`${action}:`).update(value).digest();
  const result=await pool.query(`INSERT INTO auth_rate_limits (action,bucket_hash,attempts,expires_at)
    VALUES ($1,$2,1,clock_timestamp()+($3::integer*interval '1 second'))
    ON CONFLICT (action,bucket_hash) DO UPDATE SET
      attempts=CASE WHEN auth_rate_limits.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(auth_rate_limits.attempts+1,1000000) END,
      expires_at=CASE WHEN auth_rate_limits.expires_at<=clock_timestamp() THEN clock_timestamp()+($3::integer*interval '1 second') ELSE auth_rate_limits.expires_at END
    RETURNING attempts,ceil(greatest(0,extract(epoch FROM expires_at-clock_timestamp())))::int AS retry_after`,[action,hash,seconds]);
  if(result.rows[0].attempts>limit) {
    const error=new HttpError(429,'AUTH_RATE_LIMITED'); error.retryAfter=result.rows[0].retry_after; throw error;
  }
}
