import { HttpError } from '../http-error.js';
import { createSimulatedEvent, encodeSimulatedEvent } from './events.js';

function sameEvidence(saved, body, hash) {
  return saved.payload_hash.equals(hash) && (!saved.event_body || saved.event_body.equals(body));
}
export function classifySimulatedEvent(row, event, body) {
  if (!row) return 'UNKNOWN_PAYMENT';
  if (Number(row.amount_minor) !== event.amountMinor) return 'AMOUNT_MISMATCH';
  if (row.currency !== event.currency) return 'CURRENCY_MISMATCH';
  if (row.provider_payment_id && row.provider_payment_id !== event.providerPaymentId) return 'PAYMENT_MAPPING_MISMATCH';
  if (!row.saved_provider_id) return 'PROVIDER_RECORD_MISSING';
  if (row.saved_provider_id !== event.providerPaymentId || row.saved_attempt_id !== row.id
    || Number(row.saved_amount) !== event.amountMinor || row.saved_currency !== event.currency) return 'PAYMENT_MAPPING_MISMATCH';
  const receipt = { requestKey: row.request_key, paymentAttemptId: row.id, providerPaymentId: row.saved_provider_id,
    amountMinor: Number(row.saved_amount), currency: row.saved_currency, createdAt: row.provider_created_at, paymentMode: 'simulated' };
  return row.plan.some(entry => encodeSimulatedEvent(createSimulatedEvent(receipt, entry)).equals(body)) ? null : 'EVENT_PLAN_MISMATCH';
}

export async function readSimulatedEventMapping(db, id) {
  return (await db.query(`SELECT p.id,p.request_key,p.amount_minor,p.currency,p.provider_payment_id,
    s.provider_payment_id AS saved_provider_id,s.payment_attempt_id AS saved_attempt_id,
    s.amount_minor AS saved_amount,s.currency AS saved_currency,s.plan,
    to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS provider_created_at
    FROM payment_attempts p LEFT JOIN simulated_provider_payments s ON s.request_key=p.request_key
    WHERE p.id=$1 AND p.provider='simulated'`, [id])).rows[0];
}

// Called only with the result of verifySimulatedDelivery and its original body.
// The transaction records evidence, without transitioning a payment or seat.
export async function recordSimulatedEvent(pool, { event, payloadHash }, body) {
  const db = await pool.connect(); let discard = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT set_config($1,$2,true),set_config($3,$4,true)', ['lock_timeout','250ms','statement_timeout','1500ms']);
    const existing = (await db.query(`SELECT payload_hash,event_body FROM payment_events
      WHERE provider='simulated' AND provider_event_id=$1`, [event.eventId])).rows[0];
    if (existing) {
      if (!sameEvidence(existing, body, payloadHash)) throw new HttpError(409, 'EVENT_IDENTITY_CONFLICT');
      await db.query('COMMIT'); return; // Historical receipt; never reclassify or requeue a duplicate.
    }
    const row = await readSimulatedEventMapping(db,event.paymentAttemptId);
    const reason = classifySimulatedEvent(row,event,body);
    const inserted = await db.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at)
      INSERT INTO payment_events(provider,provider_event_id,payment_attempt_id,provider_payment_id,kind,amount_minor,currency,
        payload_hash,verified_at,received_at,status,processed_at,rejection_code,event_body,occurred_at)
      SELECT 'simulated',$1,$2,$3,$4,$5,$6,$7,at,at,
        CASE WHEN $8::text IS NULL THEN 'RECEIVED' ELSE 'REJECTED' END,
        CASE WHEN $8::text IS NULL THEN NULL ELSE at END,$8,$9,$10::timestamptz FROM stamp
      ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id`,
    [event.eventId,row?.id ?? null,event.providerPaymentId,event.kind,event.amountMinor,event.currency,
      payloadHash,reason,body,event.occurredAt]);
    if (!inserted.rowCount) {
      const saved = (await db.query(`SELECT payload_hash,event_body FROM payment_events
        WHERE provider='simulated' AND provider_event_id=$1`, [event.eventId])).rows[0];
      if (!saved || !sameEvidence(saved, body, payloadHash)) throw new HttpError(409,'EVENT_IDENTITY_CONFLICT');
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => { discard = true; });
    discard ||= error.code?.startsWith('08') || error.message === 'Query read timeout';
    throw error;
  } finally { db.release(discard ? new Error('Event inbox connection unavailable') : undefined); }
}
