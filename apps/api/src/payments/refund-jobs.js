import { createHash } from 'node:crypto';
import { z } from 'zod';
import { retryDelaySeconds as backoff } from '../reliability/retry.js';
import { claimOutbox, acknowledgeOutbox, failOutbox } from '../reliability/outbox.js';
import { createSimulatedRefund, simulatedRefundId, SimulatedRefundError } from './refund-simulator.js';

class RefundLeaseExpired extends Error {}
const permanent = code => new SimulatedRefundError(code);
async function transaction(pool, work) {
  const db = await pool.connect(); let discard = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT set_config($1,$2,true),set_config($3,$4,true)', ['lock_timeout', '250ms', 'statement_timeout', '1500ms']);
    const result = await work(db); await db.query('COMMIT'); return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => { discard = true; });
    discard ||= error.code?.startsWith('08') || error.message === 'Query read timeout'; throw error;
  } finally { db.release(discard ? new Error('Refund worker connection unavailable') : undefined); }
}
async function beforeDeadline(db, deadline) {
  if (!(await db.query('SELECT clock_timestamp()<$1::timestamptz AS valid', [deadline])).rows[0].valid) throw new RefundLeaseExpired();
}
async function lockJob(db, job) {
  if (!job || job.kind !== 'REFUND_CREATE' || ![job.id, job.refund_id, job.operation_key, job.lease_token].every(id => z.uuid().safeParse(id).success)) throw permanent('REFUND_JOB_INVALID');
  const initial = (await db.query('SELECT payment_attempt_id FROM refunds WHERE id=$1', [job.refund_id])).rows[0];
  if (!initial) throw permanent('REFUND_JOB_INVALID');
  // No inventory/booking/actor lock is added after these rows.
  const pay = (await db.query('SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE', [initial.payment_attempt_id])).rows[0];
  const refund = (await db.query('SELECT * FROM refunds WHERE id=$1 FOR UPDATE', [job.refund_id])).rows[0];
  const current = (await db.query('SELECT *,lease_expires_at::text AS deadline FROM outbox_events WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
  if (!current || current.kind !== 'REFUND_CREATE' || current.refund_id !== job.refund_id || current.operation_key !== job.operation_key
    || refund.request_key !== job.operation_key) throw permanent('REFUND_JOB_INVALID');
  if (current.status !== 'PROCESSING' || current.lease_token !== job.lease_token) return null;
  await beforeDeadline(db, current.deadline);
  return { pay, refund, current };
}
async function eligible(db, pay, refund) {
  if (!pay || pay.id !== refund.payment_attempt_id || pay.provider !== 'simulated' || refund.provider !== 'simulated'
    || pay.status !== 'SUCCEEDED' || Number(pay.amount_minor) !== Number(refund.amount_minor) || pay.currency !== refund.currency
    || !/^sim_pay_[a-f0-9]{64}$/.test(pay.provider_payment_id || '')) return false;
  if (pay.resolution === 'REFUND_REQUIRED') return pay.booking_id === null && ['HOLD_EXPIRED', 'INVENTORY_LOST', 'DUPLICATE_PAYMENT'].includes(refund.reason);
  // CANCELLED is terminal. MVCC read only; never acquire booking after payment.
  return pay.resolution === 'BOOKED' && ['CUSTOMER_CANCELLED', 'EVENT_CANCELLED'].includes(refund.reason)
    && (await db.query('SELECT status FROM bookings WHERE id=$1', [pay.booking_id])).rows[0]?.status === 'CANCELLED';
}
function command(refund, pay) {
  return Object.freeze({ requestKey: refund.request_key, refundId: refund.id, paymentAttemptId: pay.id,
    providerPaymentId: pay.provider_payment_id, amountMinor: Number(refund.amount_minor), currency: refund.currency });
}
async function verified(db, input, result) {
  const ledger = (await db.query(`SELECT *,to_char(refunded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effect_at
    FROM simulated_provider_refunds WHERE request_key=$1`, [input.requestKey])).rows[0];
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest();
  return ledger && Buffer.isBuffer(ledger.request_hash) && ledger.request_hash.equals(fingerprint)
    && ledger.refund_id === input.refundId && ledger.payment_attempt_id === input.paymentAttemptId && ledger.provider_payment_id === input.providerPaymentId
    && Number(ledger.amount_minor) === input.amountMinor && ledger.currency === input.currency && ledger.provider_refund_id === simulatedRefundId(input.requestKey)
    && result?.paymentMode === 'simulated' && result.providerState === 'SUCCEEDED' && typeof result.replayed === 'boolean'
    && result.requestKey === input.requestKey && result.refundId === input.refundId && result.paymentAttemptId === input.paymentAttemptId
    && result.providerPaymentId === input.providerPaymentId && result.providerRefundId === ledger.provider_refund_id
    && result.amountMinor === input.amountMinor && result.currency === input.currency && result.refundedAt === ledger.effect_at;
}
export async function prepareRefundJob(pool, job) {
  return transaction(pool, async db => {
    const locked = await lockJob(db, job); if (!locked) return null;
    const { pay, refund, current } = locked;
    if (!await eligible(db, pay, refund)) throw permanent('REFUND_JOB_INVALID');
    if (refund.status === 'SUCCEEDED') throw permanent('REFUND_COMPLETED_REVIEW');
    if (!['REQUESTED', 'PROCESSING', 'RETRYABLE_FAILURE'].includes(refund.status)
      || (refund.provider_refund_id && refund.provider_refund_id !== simulatedRefundId(refund.request_key))) throw permanent('REFUND_JOB_INVALID');
    const updated = await db.query(`UPDATE refunds SET status='PROCESSING',processing_attempts=processing_attempts+1,
      last_error_code=NULL,next_attempt_at=clock_timestamp() WHERE id=$1`, [refund.id]);
    if (updated.rowCount !== 1) throw new Error('Refund preparation was not recorded');
    await beforeDeadline(db, current.deadline);
    return command(refund, pay);
  });
}
export async function finishRefundJob(pool, job, result) {
  return transaction(pool, async db => {
    const locked = await lockJob(db, job); if (!locked) return false;
    const { pay, refund, current } = locked;
    if (refund.status !== 'PROCESSING' || !await eligible(db, pay, refund)) throw permanent('REFUND_JOB_INVALID');
    if (!await verified(db, command(refund, pay), result)) throw permanent('REFUND_PROVIDER_RESPONSE_INVALID');
    const updated = await db.query(`UPDATE refunds SET status='SUCCEEDED',provider_refund_id=$2,completed_at=clock_timestamp(),last_error_code=NULL WHERE id=$1`, [refund.id, result.providerRefundId]);
    if (updated.rowCount !== 1) throw new Error('Refund completion was not recorded');
    // No organizer/actor FK lock after payment: worker actor and allowlisted IDs.
    await db.query(`INSERT INTO audit_events(operation_id,actor_kind,action,entity_type,entity_id,metadata)
      VALUES($1,'WORKER','refund.completed','refund',$2,$3)`, [refund.request_key, refund.id,
      { paymentAttemptId: pay.id, providerRefundId: result.providerRefundId, amountMinor: Number(refund.amount_minor), currency: refund.currency }]);
    if (!await acknowledgeOutbox(db, job.id, job.lease_token)) throw new RefundLeaseExpired();
    await beforeDeadline(db, current.deadline); // After ALL writes, same precise SQL deadline.
    return true;
  });
}
const safeCodes = new Set(['REFUND_INPUT_INVALID', 'REFUND_IDENTITY_CONFLICT', 'REFUND_PAYMENT_UNKNOWN', 'REFUND_CAPTURE_INVALID',
  'REFUND_CAPTURE_UNAVAILABLE', 'REFUND_CAPTURE_PENDING', 'REFUND_JOB_INVALID', 'REFUND_COMPLETED_REVIEW', 'REFUND_PROVIDER_RESPONSE_INVALID']);
async function recordFailure(pool, job, error, delaySeconds) {
  const typed = error instanceof SimulatedRefundError;
  const retryable = !typed || error.retryable === true;
  const code = typed ? (safeCodes.has(error.code) ? error.code : 'REFUND_PROVIDER_REVIEW') : 'REFUND_WORK_RETRY';
  return transaction(pool, async db => {
    const locked = await lockJob(db, job); if (!locked) return null;
    const { refund, current } = locked;
    if (refund.status !== 'SUCCEEDED') await db.query(`UPDATE refunds SET
      status=CASE WHEN status='PROCESSING' THEN 'RETRYABLE_FAILURE' ELSE status END,
      next_attempt_at=clock_timestamp()+($3::integer*interval '1 second'),last_error_code=$2 WHERE id=$1`, [refund.id, code, delaySeconds]);
    if (!await failOutbox(db, job.id, job.lease_token, { code, retryable, delaySeconds })) throw new RefundLeaseExpired();
    await beforeDeadline(db, current.deadline);
    return retryable && current.attempt_count < current.max_attempts ? 'retryScheduled' : 'deadLettered';
  });
}
const optionsSchema = z.object({ workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/), batchSize: z.number().int().min(1).max(10).default(5),
  leaseSeconds: z.number().int().min(1).max(300).default(30), retryDelaySeconds: z.number().int().min(0).max(3600).default(5) }).strict();
export async function runRefundBatch(pool, { signal, provider = createSimulatedRefund, ...raw } = {}) {
  const parsed = optionsSchema.safeParse(raw); if (!parsed.success) throw new TypeError('Invalid refund worker configuration');
  const { workerId, batchSize, leaseSeconds, retryDelaySeconds } = parsed.data;
  const counts = { claimed: 0, attempted: 0, providerCreated: 0, providerReplayed: 0, completed: 0, retryScheduled: 0, deadLettered: 0, stale: 0, failed: 0 };
  if (signal?.aborted) return counts;
  const jobs = await transaction(pool, db => claimOutbox(db, { workerId, batchSize, leaseSeconds, kinds: ['REFUND_CREATE'] }));
  counts.claimed = jobs.length;
  for (const job of jobs) {
    if (signal?.aborted) break;
    counts.attempted++;
    try {
      const input = await prepareRefundJob(pool, job); if (!input) { counts.stale++; continue; }
      const result = await provider(pool, input); // Claim/preparation transactions have COMMITTED.
      if (!await verified(pool, input, result)) throw permanent('REFUND_PROVIDER_RESPONSE_INVALID');
      if (result.replayed) counts.providerReplayed++; else counts.providerCreated++;
      if (await finishRefundJob(pool, job, result)) counts.completed++; else counts.stale++;
    } catch (error) {
      if (error instanceof RefundLeaseExpired) { counts.stale++; continue; }
      counts.failed++;
      try { const outcome = await recordFailure(pool, job, error, backoff(job.attempt_count, retryDelaySeconds)); if (outcome) counts[outcome]++; else counts.stale++; }
      catch (failure) { if (failure instanceof RefundLeaseExpired) counts.stale++; else counts.failed++; }
    }
  }
  return counts;
}
