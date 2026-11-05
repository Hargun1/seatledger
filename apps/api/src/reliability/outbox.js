import { z } from 'zod';

const claimSchema = z.object({
  workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  batchSize: z.number().int().min(1).max(50).default(10),
  leaseSeconds: z.number().int().min(1).max(300).default(30),
  kinds: z.array(z.enum(['PAYMENT_CREATE', 'REFUND_CREATE'])).min(1).max(2)
    .refine(values => new Set(values).size === values.length).default(['PAYMENT_CREATE', 'REFUND_CREATE'])
});
function leaseIdentity(id, token) {
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(token).success) throw new TypeError('Invalid outbox lease identity');
}

// A short claim transaction only; commit it before provider interaction.
export async function claimOutbox(db, input) {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid outbox claim');
  const { workerId, batchSize, leaseSeconds, kinds } = parsed.data;
  // Exhausted abandoned leases become visible dead letters, never stuck work.
  await db.query(`WITH exhausted AS (
    SELECT id FROM outbox_events WHERE kind=ANY($2::text[]) AND status='PROCESSING' AND lease_expires_at<=clock_timestamp()
      AND attempt_count>=max_attempts ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT $1
  ) UPDATE outbox_events o SET status='DEAD_LETTER',completed_at=clock_timestamp(),last_error_code='LEASE_EXHAUSTED',
    lease_token=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL FROM exhausted e WHERE o.id=e.id`, [batchSize,kinds]);
  return (await db.query(`WITH candidates AS (
    SELECT id FROM outbox_events WHERE kind=ANY($4::text[]) AND attempt_count<max_attempts AND (
      (status IN ('READY','RETRY_WAIT') AND next_attempt_at<=clock_timestamp()) OR
      (status='PROCESSING' AND lease_expires_at<=clock_timestamp()))
    ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $1
  ) UPDATE outbox_events o SET status='PROCESSING',attempt_count=o.attempt_count+1,
    lease_token=gen_random_uuid(),claimed_by=$2,claimed_at=clock_timestamp(),
    lease_expires_at=clock_timestamp()+($3::integer*interval '1 second')
    FROM candidates c WHERE o.id=c.id RETURNING o.*`, [batchSize,workerId,leaseSeconds,kinds])).rows;
}

export async function acknowledgeOutbox(db, id, token) {
  leaseIdentity(id,token);
  const result = await db.query(`UPDATE outbox_events SET status='SUCCEEDED',completed_at=clock_timestamp(),last_error_code=NULL,
    lease_token=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
    WHERE id=$1 AND status='PROCESSING' AND lease_token=$2 AND lease_expires_at>clock_timestamp()`, [id,token]);
  return result.rowCount === 1;
}

export async function failOutbox(db, id, token, { code, retryable = true, delaySeconds = 5 }) {
  leaseIdentity(id,token);
  if (!/^[A-Z0-9_]{1,64}$/.test(code ?? '') || typeof retryable !== 'boolean' || !Number.isInteger(delaySeconds) || delaySeconds<0 || delaySeconds>3600) throw new TypeError('Invalid outbox failure');
  const result = await db.query(`UPDATE outbox_events SET
    status=CASE WHEN $4 AND attempt_count<max_attempts THEN 'RETRY_WAIT' ELSE 'DEAD_LETTER' END,
    completed_at=CASE WHEN $4 AND attempt_count<max_attempts THEN NULL ELSE clock_timestamp() END,
    next_attempt_at=clock_timestamp()+($5::integer*interval '1 second'),last_error_code=$3,
    lease_token=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
    WHERE id=$1 AND status='PROCESSING' AND lease_token=$2 AND lease_expires_at>clock_timestamp()`, [id,token,code,retryable,delaySeconds]);
  return result.rowCount === 1;
}
