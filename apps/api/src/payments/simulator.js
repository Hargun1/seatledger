import { createHash } from 'node:crypto';
import { z } from 'zod';

export const simulatorScenarios = ['success', 'failure', 'delayed-success', 'duplicate', 'out-of-order', 'late-success'];
const id = z.uuid().transform(value => value.toLowerCase());
const inputSchema = z.object({ requestKey: id, paymentAttemptId: id,
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[A-Z]{3}$/),
  scenario: z.enum(simulatorScenarios).default('success') }).strict();
const hash = text => createHash('sha256').update(text).digest('hex');
export class SimulatedProviderError extends Error {
  constructor(code) { super('The simulated provider could not verify this operation.'); this.code = code; }
}
export function simulatedPaymentId(key) { return 'sim_pay_' + hash(key.toLowerCase()); }
export function simulatedPlan(key, scenario) {
  if (!z.uuid().safeParse(key).success || !simulatorScenarios.includes(scenario)) throw new SimulatedProviderError('INVALID_SIMULATOR_INPUT');
  const event = (name, kind, occurredAfterMs, deliverAfterMs = occurredAfterMs) => ({
    eventId: 'sim_evt_' + hash(`${key.toLowerCase()}:${name}`), kind, occurredAfterMs, deliverAfterMs });
  const pending = event('pending', 'PAYMENT_PENDING', 0);
  const success = event('success', 'PAYMENT_SUCCEEDED', 100);
  const failure = event('failure', 'PAYMENT_FAILED', 100);
  if (scenario === 'success') return [pending, success];
  if (scenario === 'failure') return [pending, failure];
  if (scenario === 'delayed-success') return [pending, event('success', 'PAYMENT_SUCCEEDED', 360000)];
  if (scenario === 'duplicate') return [pending, success, { ...success, deliverAfterMs: 200 }];
  if (scenario === 'out-of-order') return [event('success', 'PAYMENT_SUCCEEDED', 100, 0), event('pending', 'PAYMENT_PENDING', 0, 100), event('failure', 'PAYMENT_FAILED', 50, 200)];
  return [pending, failure, event('success', 'PAYMENT_SUCCEEDED', 200)];
}

const fields = `request_key,payment_attempt_id,request_hash,provider_payment_id,amount_minor::text AS amount,currency,scenario,plan,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;
export async function createSimulatedPayment(pool, input) {
  const checked = inputSchema.safeParse(input);
  if (!checked.success) throw new SimulatedProviderError('INVALID_SIMULATOR_INPUT');
  const { requestKey, paymentAttemptId, amountMinor, currency, scenario } = checked.data;
  // Scenario is a first-call test configuration, not part of retry identity.
  // Once saved, retries return that original immutable plan even after config changes.
  const requestHash = Buffer.from(hash(JSON.stringify({ requestKey, paymentAttemptId, amountMinor, currency })), 'hex');
  const db = await pool.connect(); let discard = false;
  try {
    // Deliberately no BEGIN: the provider effect commits independently of the
    // caller's claim/finalization transactions. Same local DB, separate boundary.
    // Both unique indexes describe the same deterministic operation. Concurrent
    // inserts may encounter the provider-ID index first, so arbitrate every
    // unique conflict, then require the original request key/hash below.
    const created = await db.query(`INSERT INTO simulated_provider_payments
      (request_key,payment_attempt_id,request_hash,provider_payment_id,amount_minor,currency,scenario,plan)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING RETURNING ${fields}`,
    [requestKey, paymentAttemptId, requestHash, simulatedPaymentId(requestKey), amountMinor, currency, scenario, JSON.stringify(simulatedPlan(requestKey, scenario))]);
    const row = created.rows[0] ?? (await db.query(`SELECT ${fields} FROM simulated_provider_payments WHERE request_key=$1`, [requestKey])).rows[0];
    if (!row || !row.request_hash.equals(requestHash)) throw new SimulatedProviderError('PROVIDER_IDENTITY_CONFLICT');
    return { requestKey: row.request_key, paymentAttemptId: row.payment_attempt_id, providerPaymentId: row.provider_payment_id,
      amountMinor: Number(row.amount), currency: row.currency, scenario: row.scenario, plan: row.plan,
      createdAt: row.created_at, providerState: 'PENDING', paymentMode: 'simulated', replayed: !created.rowCount };
  } catch (error) {
    discard = error.code?.startsWith('08') || error.message === 'Query read timeout'; throw error;
  } finally { db.release(discard ? new Error('Simulated provider connection unavailable') : undefined); }
}
