import { HttpError } from '../http-error.js';
import { lockShowGate, lockShowSeats } from '../reservations/service.js';

const fields = `id,reservation_id AS "reservationId",show_id AS "showId",status,resolution,
  amount_minor::text AS amount,currency,booking_id AS "bookingId",
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;
function present(row) {
  const { amount, ...payment } = row;
  return { ...payment, amountMinor: Number(amount), paymentMode: 'simulated' };
}
export async function readPayment(db, userId, id) {
  const row = (await db.query(`SELECT ${fields} FROM payment_attempts WHERE id=$1 AND user_id=$2`, [id, userId])).rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  return present(row);
}
export async function listPayments(db, userId, reservationId, { after } = {}) {
  const owned = (await db.query('SELECT id FROM reservations WHERE id=$1 AND user_id=$2 AND sealed_at IS NOT NULL', [reservationId, userId])).rows[0];
  if (!owned) throw new HttpError(404, 'NOT_FOUND');
  const rows = (await db.query(`SELECT ${fields} FROM payment_attempts
    WHERE reservation_id=$1 AND user_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 21`, [reservationId, userId, after ?? null])).rows;
  const items = rows.slice(0, 20).map(present);
  return { reservationId, items, nextCursor: rows.length > 20 ? items.at(-1).id : null, paymentMode: 'simulated' };
}
async function assertPayable(db, userId, id) {
  // Separate statement AFTER catalogue, stock, reservation and existing-attempt
  // locks. Wall time is not frozen at transaction start or before a wait.
  const valid = (await db.query(`WITH now AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT r.status='ACTIVE' AND r.sealed_at IS NOT NULL AND r.expires_at>now.at AND s.starts_at>now.at
      AND EXISTS(SELECT 1 FROM reservation_items i WHERE i.reservation_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM reservation_items i LEFT JOIN show_seats stock
        ON stock.show_id=i.show_id AND stock.venue_seat_id=i.venue_seat_id
        WHERE i.reservation_id=r.id AND (stock.state IS DISTINCT FROM 'HELD'
          OR stock.reservation_id IS DISTINCT FROM r.id OR stock.expires_at IS DISTINCT FROM r.expires_at)) AS valid
    FROM reservations r JOIN shows s ON s.id=r.show_id CROSS JOIN now WHERE r.id=$1 AND r.user_id=$2`, [id, userId])).rows[0]?.valid;
  if (!valid) throw new HttpError(409, 'RESERVATION_NOT_PAYABLE');
}
export async function createPayment(db, userId, reservationId) {
  const row = (await db.query('SELECT show_id FROM reservations WHERE id=$1 AND user_id=$2', [reservationId, userId])).rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  await lockShowGate(db, row.show_id, true);
  const items = (await db.query('SELECT venue_seat_id FROM reservation_items WHERE reservation_id=$1 ORDER BY venue_seat_id', [reservationId])).rows;
  const locked = await lockShowSeats(db, row.show_id, items.map(i => i.venue_seat_id));
  if (items.length < 1 || items.length > 8 || locked.length !== items.length) throw new HttpError(409, 'RESERVATION_NOT_PAYABLE');
  await db.query('SELECT id FROM reservations WHERE id=$1 AND user_id=$2 FOR UPDATE', [reservationId, userId]);
  const existing = (await db.query(`SELECT p.id,EXISTS(SELECT 1 FROM outbox_events o
      WHERE o.kind='PAYMENT_CREATE' AND o.payment_attempt_id=p.id AND o.operation_key=p.request_key) AS queued
    FROM payment_attempts p WHERE p.reservation_id=$1 AND p.user_id=$2 ORDER BY p.id LIMIT 2 FOR UPDATE OF p`, [reservationId, userId])).rows;
  await assertPayable(db, userId, reservationId);
  if (existing.length > 1 || (existing.length && !existing[0].queued)) throw new HttpError(409, 'PAYMENT_REVIEW_REQUIRED');
  // Initial policy: one attempt per reservation through this API, even across
  // different HTTP keys. No automatic rebilling after a failed attempt.
  if (existing.length) return { created: false, payment: await readPayment(db, userId, existing[0].id) };
  const attempt = (await db.query(`INSERT INTO payment_attempts(reservation_id,show_id,user_id,amount_minor,currency)
    SELECT id,show_id,user_id,total_minor,currency FROM reservations WHERE id=$1 AND user_id=$2
    RETURNING id,request_key`, [reservationId, userId])).rows[0];
  await db.query(`INSERT INTO outbox_events(kind,payment_attempt_id,operation_key,payload)
    VALUES('PAYMENT_CREATE',$1,$2,$3::jsonb)`, [attempt.id, attempt.request_key, JSON.stringify({ paymentMode: 'simulated' })]);
  await assertPayable(db, userId, reservationId); // Roll back attempt/job/key if work crossed expiry.
  return { created: true, payment: await readPayment(db, userId, attempt.id) };
}
