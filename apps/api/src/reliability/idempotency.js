import { z } from 'zod';

const inputSchema = z.object({
  userId: z.uuid(), operation: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/),
  key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  requestHash: z.instanceof(Buffer).refine(value => value.length === 32)
});
function checked(input) {
  const result = inputSchema.safeParse(input);
  if (!result.success) throw new TypeError('Invalid idempotency input');
  return result.data;
}

// Caller must use one checked-out client and one explicit transaction for
// claim, all business writes and completion. No HTTP/provider call here.
export async function claimIdempotency(db, input) {
  const { userId, operation, key, requestHash } = checked(input);
  const result = await db.query(`INSERT INTO idempotency_keys (user_id,operation,key,request_hash)
    VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,operation,key) DO NOTHING RETURNING key`, [userId,operation,key,requestHash]);
  if (result.rowCount) return { kind: 'claimed' };
  const existing = (await db.query('SELECT status,request_hash,response_status,response_body FROM idempotency_keys WHERE user_id=$1 AND operation=$2 AND key=$3 FOR UPDATE', [userId,operation,key])).rows[0];
  if (!existing) throw new Error('Idempotency conflict could not be resolved');
  if (!existing.request_hash.equals(requestHash)) return { kind: 'conflict' };
  if (existing.status !== 'COMPLETED') throw new Error('Idempotency claim is already in progress in this transaction');
  return { kind: 'replay', status: existing.response_status, body: existing.response_body };
}

export async function completeIdempotency(db, input, status, body) {
  const { userId, operation, key, requestHash } = checked(input);
  const result = await db.query(`UPDATE idempotency_keys SET status='COMPLETED',response_status=$4,
    response_body=$5::jsonb,completed_at=clock_timestamp()
    WHERE user_id=$1 AND operation=$2 AND key=$3 AND status='IN_PROGRESS' AND request_hash=$6`, [userId,operation,key,status,JSON.stringify(body),requestHash]);
  if (result.rowCount !== 1) throw new Error('Idempotency claim is not in progress');
}
