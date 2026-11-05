import { HttpError } from '../http-error.js';

// Caller owns a transaction (HTTP callers also own authorization/key claims).
// Every allocation writer takes these catalogue gates BEFORE inventory.
export async function lockShowGate(db, showId, selling) {
  const initial = (await db.query('SELECT organizer_id,event_id FROM shows WHERE id=$1', [showId])).rows[0];
  if (!initial) throw new HttpError(404, 'NOT_FOUND');
  const organization = (await db.query('SELECT status FROM organizers WHERE id=$1 FOR SHARE', [initial.organizer_id])).rows[0];
  const event = (await db.query('SELECT status FROM events WHERE id=$1 AND organizer_id=$2 FOR SHARE', [initial.event_id, initial.organizer_id])).rows[0];
  const show = (await db.query('SELECT status FROM shows WHERE id=$1 AND event_id=$2 AND organizer_id=$3 FOR SHARE', [showId, initial.event_id, initial.organizer_id])).rows[0];
  if (!event || !show || (selling && (organization?.status !== 'APPROVED' || event.status !== 'PUBLISHED' || show.status !== 'SCHEDULED'))) throw new HttpError(404, 'NOT_FOUND');
}
export async function lockShowSeats(db, showId, ids) {
  return (await db.query(`SELECT venue_seat_id AS id,price_minor AS "priceMinor",currency
    FROM show_seats WHERE show_id=$1 AND venue_seat_id=ANY($2::uuid[])
    ORDER BY show_id,venue_seat_id FOR UPDATE`, [showId, ids])).rows;
}
export async function readReservation(db, userId, id) {
  const row = (await db.query(`SELECT id,show_id AS "showId",status,
    CASE WHEN status='ACTIVE' AND expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE status END AS "effectiveStatus",
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
    to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt",
    currency,total_minor::text AS total FROM reservations WHERE id=$1 AND user_id=$2 AND sealed_at IS NOT NULL`, [id, userId])).rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  const items = (await db.query(`SELECT venue_seat_id AS id,price_minor AS "priceMinor",currency
    FROM reservation_items WHERE reservation_id=$1 ORDER BY venue_seat_id`, [id])).rows;
  const { total, ...header } = row;
  return { ...header, totalMinor: Number(total), items, paymentMode: 'simulated' };
}
export async function createReservation(db, userId, { showId, seatIds }) {
  await lockShowGate(db, showId, true);
  const ids = [...seatIds].sort(), seats = await lockShowSeats(db, showId, ids);
  // This statement begins AFTER every requested row lock has been acquired.
  // All expiry comparisons stay inside SQL; no browser/Date precision decision.
  const check = (await db.query(`WITH now AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT s.starts_at>now.at AS future,
      ARRAY(SELECT unnest($2::uuid[]) EXCEPT SELECT venue_seat_id FROM show_seats
        WHERE show_id=$1 AND (state='AVAILABLE' OR (state='HELD' AND expires_at<=now.at))) AS unavailable
    FROM shows s CROSS JOIN now WHERE s.id=$1`, [showId, ids])).rows[0];
  if (!check?.future) throw new HttpError(409, 'SHOW_STARTED');
  if (seats.length !== ids.length || check.unavailable.length) {
    const error = new HttpError(409, 'SEATS_UNAVAILABLE'); error.unavailableSeatIds = check.unavailable.sort(); throw error;
  }
  if (new Set(seats.map(s => s.currency)).size !== 1) throw new HttpError(409, 'MIXED_CURRENCY');
  const total = seats.reduce((sum, s) => sum + s.priceMinor, 0);
  const reservation = (await db.query(`WITH now AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO reservations(user_id,show_id,currency,total_minor,created_at,expires_at)
    SELECT $1,$2,$3,$4,at,at+interval '5 minutes' FROM now RETURNING id`, [userId, showId, seats[0].currency, total])).rows[0];
  await db.query(`INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency)
    SELECT $1,show_id,venue_seat_id,price_minor,currency FROM show_seats
    WHERE show_id=$2 AND venue_seat_id=ANY($3::uuid[]) ORDER BY venue_seat_id`, [reservation.id, showId, ids]);
  await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [reservation.id]);
  const updated = await db.query(`UPDATE show_seats stock SET state='HELD',reservation_id=r.id,booking_id=NULL,expires_at=r.expires_at
    FROM reservations r WHERE r.id=$1 AND stock.show_id=$2 AND stock.venue_seat_id=ANY($3::uuid[])`, [reservation.id, showId, ids]);
  if (updated.rowCount !== ids.length) throw new Error('Incomplete allocation');
  const valid = (await db.query(`SELECT clock_timestamp()<s.starts_at AND clock_timestamp()<r.expires_at AS valid
    FROM reservations r JOIN shows s ON s.id=r.show_id WHERE r.id=$1`, [reservation.id])).rows[0].valid;
  if (!valid) throw new HttpError(409, 'SHOW_STARTED'); // Caller rolls back ALL writes.
  return readReservation(db, userId, reservation.id);
}
export async function releaseReservation(db, userId, id) {
  const initial = (await db.query('SELECT show_id FROM reservations WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!initial) throw new HttpError(404, 'NOT_FOUND');
  // Release remains possible when sales/organizer access is suspended.
  await lockShowGate(db, initial.show_id, false);
  const items = (await db.query('SELECT venue_seat_id FROM reservation_items WHERE reservation_id=$1 ORDER BY venue_seat_id', [id])).rows;
  await lockShowSeats(db, initial.show_id, items.map(i => i.venue_seat_id));
  const current = (await db.query('SELECT status FROM reservations WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0];
  if (current.status === 'CONFIRMED') throw new HttpError(409, 'RESERVATION_CLOSED');
  if (current.status === 'ACTIVE') {
    await db.query(`UPDATE reservations SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'RELEASED' END,
      closed_at=clock_timestamp() WHERE id=$1`, [id]);
    await db.query(`UPDATE show_seats SET state='AVAILABLE',reservation_id=NULL,booking_id=NULL,expires_at=NULL
      WHERE show_id=$1 AND reservation_id=$2 AND state='HELD'`, [initial.show_id, id]);
  }
  return readReservation(db, userId, id);
}
