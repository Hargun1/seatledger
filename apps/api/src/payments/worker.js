import { z } from 'zod';
import { claimOutbox, acknowledgeOutbox, failOutbox } from '../reliability/outbox.js';
import { createSimulatedPayment, simulatedPaymentId, simulatorScenarios, SimulatedProviderError } from './simulator.js';

async function transaction(pool, work) {
  const db = await pool.connect(); let discard = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT set_config($1,$2,true),set_config($3,$4,true)', ['lock_timeout', '250ms', 'statement_timeout', '1500ms']);
    const result = await work(db); await db.query('COMMIT'); return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => { discard = true; });
    discard ||= error.code?.startsWith('08') || error.message === 'Query read timeout'; throw error;
  } finally { db.release(discard ? new Error('Payment worker connection unavailable') : undefined); }
}
function verified(job, attempt, result) {
  return job.kind === 'PAYMENT_CREATE' && attempt && job.payment_attempt_id === attempt.id && job.operation_key === attempt.request_key
    && attempt.provider === 'simulated' && result?.paymentMode === 'simulated' && result.providerState === 'PENDING'
    && result.requestKey === attempt.request_key && result.paymentAttemptId === attempt.id
    && result.amountMinor === Number(attempt.amount_minor) && result.currency === attempt.currency
    && result.providerPaymentId === simulatedPaymentId(attempt.request_key)
    && (!attempt.provider_payment_id || attempt.provider_payment_id === result.providerPaymentId);
}
export async function finishPaymentJob(pool, job, result) {
  return transaction(pool, async db => {
    // Only payment -> outbox here. No catalogue/inventory/parent lock or provider
    // call is reached from these rows. All lease checks follow the row waits.
    const attempt = (await db.query('SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE', [job.payment_attempt_id])).rows[0];
    const current = (await db.query('SELECT * FROM outbox_events WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
    if (!current || !verified(current, attempt, result) || current.payment_attempt_id !== job.payment_attempt_id || current.operation_key !== job.operation_key)
      throw new SimulatedProviderError('INVALID_PAYMENT_JOB');
    // A stale lease must change neither the job NOR the attempt.
    if (!await acknowledgeOutbox(db, job.id, job.lease_token)) return false;
    await db.query(`UPDATE payment_attempts SET provider_payment_id=$2,
      status=CASE WHEN status='CREATED' THEN 'PENDING' ELSE status END WHERE id=$1`, [attempt.id, result.providerPaymentId]);
    return true;
  });
}
const optionsSchema = z.object({ workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  batchSize: z.number().int().min(1).max(10).default(5), leaseSeconds: z.number().int().min(1).max(300).default(30),
  retryDelaySeconds: z.number().int().min(0).max(3600).default(5), scenario: z.enum(simulatorScenarios).default('success') });
export async function runPaymentBatch(pool, { signal, provider = createSimulatedPayment, ...raw } = {}) {
  const parsed = optionsSchema.safeParse(raw); if (!parsed.success) throw new TypeError('Invalid payment worker configuration');
  const { workerId, batchSize, leaseSeconds, retryDelaySeconds, scenario } = parsed.data;
  const counts = { claimed: 0, attempted: 0, providerCreated: 0, providerReplayed: 0, completed: 0, retryScheduled: 0, deadLettered: 0, stale: 0, failed: 0 };
  if (signal?.aborted) return counts;
  const jobs = await transaction(pool, db => claimOutbox(db, { workerId, batchSize, leaseSeconds, kinds: ['PAYMENT_CREATE'] }));
  counts.claimed = jobs.length;
  for (const job of jobs) {
    if (signal?.aborted) break; // Remaining claimed leases can be recovered after expiry.
    counts.attempted++;
    try {
      const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE id=$1', [job.payment_attempt_id])).rows[0];
      if (!attempt || job.kind !== 'PAYMENT_CREATE' || attempt.provider !== 'simulated' || attempt.request_key !== job.operation_key)
        throw new SimulatedProviderError('INVALID_PAYMENT_JOB');
      const result = await provider(pool, { requestKey: attempt.request_key, paymentAttemptId: attempt.id,
        amountMinor: Number(attempt.amount_minor), currency: attempt.currency, scenario });
      if (!verified(job, attempt, result) || typeof result.replayed !== 'boolean') throw new SimulatedProviderError('INVALID_PROVIDER_RESPONSE');
      if (result.replayed) counts.providerReplayed++; else counts.providerCreated++;
      if (await finishPaymentJob(pool, job, result)) counts.completed++; else counts.stale++;
    } catch (error) {
      counts.failed++;
      const permanent = error instanceof SimulatedProviderError;
      try {
        const changed = await transaction(pool, db => failOutbox(db, job.id, job.lease_token,
          { code: permanent ? error.code : 'PAYMENT_WORK_RETRY', retryable: !permanent, delaySeconds: retryDelaySeconds }));
        if (!changed) counts.stale++;
        else if (permanent || job.attempt_count >= job.max_attempts) counts.deadLettered++;
        else counts.retryScheduled++;
      } catch { counts.failed++; } // Lease recovery remains available; no raw errors/secrets logged.
    }
  }
  return counts;
}
