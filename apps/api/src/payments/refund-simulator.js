import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { simulatedPaymentId, simulatedPlan } from './simulator.js';

const id = z.uuid().transform(value => value.toLowerCase());
const inputSchema = z.object({ requestKey: id, refundId: id, paymentAttemptId: id,
  providerPaymentId: z.string().regex(/^sim_pay_[a-f0-9]{64}$/),
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest();
export class SimulatedRefundError extends Error {
  constructor(code, retryable = false) { super('The simulated refund could not be verified.'); this.code = code; this.retryable = retryable; }
}
export function simulatedRefundId(key) {
  const checked = id.safeParse(key);
  if (!checked.success) throw new SimulatedRefundError('REFUND_INPUT_INVALID');
  return 'sim_ref_' + createHash('sha256').update('seatledger:refund:v1:' + checked.data).digest('hex');
}
const columns = `request_key,refund_id,payment_attempt_id,provider_payment_id,provider_refund_id,request_hash,
  amount_minor::text AS amount,currency,
  to_char(refunded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS refunded_at`;

function present(row, input, requestHash, replayed) {
  if (!row || !Buffer.isBuffer(row.request_hash) || !row.request_hash.equals(requestHash)
    || row.request_key !== input.requestKey || row.refund_id !== input.refundId || row.payment_attempt_id !== input.paymentAttemptId
    || row.provider_payment_id !== input.providerPaymentId || Number(row.amount) !== input.amountMinor || row.currency !== input.currency
    || row.provider_refund_id !== simulatedRefundId(input.requestKey)) throw new SimulatedRefundError('REFUND_IDENTITY_CONFLICT');
  return { requestKey: row.request_key, refundId: row.refund_id, paymentAttemptId: row.payment_attempt_id,
    providerPaymentId: row.provider_payment_id, providerRefundId: row.provider_refund_id,
    amountMinor: Number(row.amount), currency: row.currency, refundedAt: row.refunded_at,
    providerState: 'SUCCEEDED', paymentMode: 'simulated', replayed };
}

export async function createSimulatedRefund(pool, raw) {
  const checked = inputSchema.safeParse(raw);
  if (!checked.success) throw new SimulatedRefundError('REFUND_INPUT_INVALID');
  const input = checked.data;
  const requestHash = hash({ requestKey: input.requestKey, refundId: input.refundId, paymentAttemptId: input.paymentAttemptId,
    providerPaymentId: input.providerPaymentId, amountMinor: input.amountMinor, currency: input.currency });
  const db = await pool.connect(); let discard = false;
  try {
    // Autocommit on a separate connection: never join the caller's business TX.
    const previous = (await db.query(`SELECT ${columns} FROM simulated_provider_refunds WHERE request_key=$1`, [input.requestKey])).rows[0];
    if (previous) return present(previous, input, requestHash, true);
    const source = (await db.query('SELECT * FROM simulated_provider_payments WHERE provider_payment_id=$1', [input.providerPaymentId])).rows[0];
    if (!source) throw new SimulatedRefundError('REFUND_PAYMENT_UNKNOWN');
    if (!id.safeParse(source.request_key).success) throw new SimulatedRefundError('REFUND_CAPTURE_INVALID');
    const sourceHash = hash({ requestKey: source.request_key, paymentAttemptId: source.payment_attempt_id,
      amountMinor: Number(source.amount_minor), currency: source.currency });
    if (source.payment_attempt_id !== input.paymentAttemptId || Number(source.amount_minor) !== input.amountMinor || source.currency !== input.currency
      || source.provider_payment_id !== simulatedPaymentId(source.request_key)
      || !Buffer.isBuffer(source.request_hash) || !source.request_hash.equals(sourceHash)
      || !isDeepStrictEqual(source.plan, simulatedPlan(source.request_key, source.scenario))) throw new SimulatedRefundError('REFUND_CAPTURE_INVALID');
    const success = source.plan.find(event => event.kind === 'PAYMENT_SUCCEEDED');
    if (!success) throw new SimulatedRefundError('REFUND_CAPTURE_UNAVAILABLE');

    // Preserve the eligibility decision from THIS SQL statement. Rechecking time
    // after a failed insert could confuse "not due yet" with a unique conflict.
    const decision = (await db.query(`WITH capture AS MATERIALIZED (
      SELECT clock_timestamp() >= created_at + ($9::integer * interval '1 millisecond') AS ready
      FROM simulated_provider_payments WHERE provider_payment_id=$4 AND payment_attempt_id=$3
        AND amount_minor=$7 AND currency=$8
    ), effect AS (
      INSERT INTO simulated_provider_refunds(request_key,refund_id,payment_attempt_id,provider_payment_id,provider_refund_id,request_hash,amount_minor,currency)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM capture WHERE ready
      ON CONFLICT DO NOTHING RETURNING ${columns}
    ) SELECT effect.*,capture.ready AS capture_ready FROM capture LEFT JOIN effect ON true`,
    [input.requestKey, input.refundId, input.paymentAttemptId, input.providerPaymentId, simulatedRefundId(input.requestKey), requestHash,
      input.amountMinor, input.currency, success.occurredAfterMs])).rows[0];
    if (decision?.request_key) return present(decision, input, requestHash, false);
    // Arbitrates every unique index, including concurrent first calls and a
    // different request key trying to refund the same full payment again.
    const existing = (await db.query(`SELECT ${columns} FROM simulated_provider_refunds WHERE request_key=$1`, [input.requestKey])).rows[0];
    if (existing) return present(existing, input, requestHash, true);
    if (!decision) throw new SimulatedRefundError('REFUND_PAYMENT_UNKNOWN');
    if (!decision.capture_ready) throw new SimulatedRefundError('REFUND_CAPTURE_PENDING', true);
    throw new SimulatedRefundError('REFUND_IDENTITY_CONFLICT');
  } catch (error) {
    discard = error.code?.startsWith('08') || error.message === 'Query read timeout'; throw error;
  } finally { db.release(discard ? new Error('Simulated refund connection unavailable') : undefined); }
}
