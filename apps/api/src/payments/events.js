import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { simulatedPaymentId } from './simulator.js';

export const MAX_SIMULATED_EVENT_BYTES = 8192;
export const SIMULATED_SIGNATURE_WINDOW_SECONDS = 300;
const uuid = z.uuid().length(36).refine(value => value === value.toLowerCase());
const eventId = z.string().length(72).regex(/^sim_evt_[a-f0-9]{64}$/);
const paymentId = z.string().length(72).regex(/^sim_pay_[a-f0-9]{64}$/);
const kind = z.enum(['PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_SUCCEEDED']);
const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const currency = z.string().length(3).regex(/^[A-Z]{3}$/);
const canonicalInstant = z.string().refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
});
const eventSchema = z.object({ version: z.literal(1), provider: z.literal('simulated'), paymentMode: z.literal('simulated'),
  eventId, paymentAttemptId: uuid, providerPaymentId: paymentId, kind, amountMinor: amount, currency,
  occurredAt: canonicalInstant }).strict();
const receiptSchema = z.object({ requestKey: uuid, paymentAttemptId: uuid, providerPaymentId: paymentId,
  amountMinor: amount, currency, createdAt: z.iso.datetime(), paymentMode: z.literal('simulated') });
const planSchema = z.object({ eventId, kind, occurredAfterMs: z.number().int().min(0).max(86400000),
  deliverAfterMs: z.number().int().min(0).max(86400000) }).strict();

export class SimulatedEventError extends Error {
  constructor(code) { super('The simulated payment event could not be verified.'); this.code = code; }
}
function checked(schema, value, code) {
  const result = schema.safeParse(value);
  if (!result.success) throw new SimulatedEventError(code);
  return result.data;
}
function secretKey(secret) {
  if (typeof secret !== 'string' || secret.length !== 64 || !/^[a-f0-9]{64}$/.test(secret))
    throw new TypeError('A separate 32-byte simulated event signing secret is required.');
  return Buffer.from(secret, 'hex');
}
function clockSeconds(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8640000000000000)
    throw new TypeError('Invalid simulated delivery clock.');
  return Math.floor(nowMs / 1000);
}
function requireBody(body) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_SIMULATED_EVENT_BYTES)
    throw new SimulatedEventError('INVALID_EVENT_BODY');
}
function mac(key, timestamp, body) {
  return createHmac('sha256', key).update(`seatledger.simulated-payment.v1\n${timestamp}\n`).update(body).digest();
}

// Use only a saved provider receipt/plan. This pure helper does not establish
// database provenance, capture funds, deliver an event or confirm a reservation.
export function createSimulatedEvent(receipt, planned) {
  const saved = checked(receiptSchema, receipt, 'INVALID_EVENT_SOURCE');
  const entry = checked(planSchema, planned, 'INVALID_EVENT_SOURCE');
  if (saved.providerPaymentId !== simulatedPaymentId(saved.requestKey)) throw new SimulatedEventError('INVALID_EVENT_SOURCE');
  const occurred = Date.parse(saved.createdAt) + entry.occurredAfterMs;
  if (!Number.isFinite(occurred) || occurred < 0 || occurred > 253402300799999) throw new SimulatedEventError('INVALID_EVENT_SOURCE');
  return checked(eventSchema, { version: 1, provider: 'simulated', paymentMode: 'simulated', eventId: entry.eventId,
    paymentAttemptId: saved.paymentAttemptId, providerPaymentId: saved.providerPaymentId, kind: entry.kind,
    amountMinor: saved.amountMinor, currency: saved.currency, occurredAt: new Date(occurred).toISOString() }, 'INVALID_EVENT_SOURCE');
}

export function encodeSimulatedEvent(value) {
  const event = checked(eventSchema, value, 'INVALID_EVENT_BODY');
  // Fixed field order/format: one wire representation also rejects duplicate
  // JSON keys, unexpected whitespace and lossy UTF-8 on the receiving side.
  return Buffer.from(JSON.stringify({ version: event.version, provider: event.provider, paymentMode: event.paymentMode,
    eventId: event.eventId, paymentAttemptId: event.paymentAttemptId, providerPaymentId: event.providerPaymentId,
    kind: event.kind, amountMinor: event.amountMinor, currency: event.currency, occurredAt: event.occurredAt }));
}

export function signSimulatedDelivery(body, { secret, nowMs = Date.now() } = {}) {
  const key = secretKey(secret), timestamp = clockSeconds(nowMs);
  requireBody(body);
  return `t=${timestamp},v1=${mac(key, timestamp, body).toString('hex')}`;
}

export function verifySimulatedDelivery(body, signature, { secret, nowMs = Date.now() } = {}) {
  const key = secretKey(secret), now = clockSeconds(nowMs);
  requireBody(body);
  // One exact header; a future HTTP boundary must reject duplicate raw headers.
  const match = typeof signature === 'string' && /^t=(0|[1-9][0-9]{0,12}),v1=([a-f0-9]{64})$/.exec(signature);
  if (!match || match[0] !== signature) throw new SimulatedEventError('INVALID_EVENT_SIGNATURE');
  const timestamp = Number(match[1]);
  const expected = mac(key, timestamp, body), supplied = Buffer.from(match[2], 'hex');
  if (!timingSafeEqual(expected, supplied)) throw new SimulatedEventError('INVALID_EVENT_SIGNATURE');
  if (Math.abs(now - timestamp) > SIMULATED_SIGNATURE_WINDOW_SECONDS) throw new SimulatedEventError('STALE_EVENT_DELIVERY');
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); }
  catch { throw new SimulatedEventError('INVALID_EVENT_BODY'); }
  const event = checked(eventSchema, parsed, 'INVALID_EVENT_BODY');
  if (!body.equals(encodeSimulatedEvent(event))) throw new SimulatedEventError('INVALID_EVENT_BODY');
  return { event, sentAtSeconds: timestamp, payloadHash: createHash('sha256').update(body).digest() };
}
