import { randomUUID, createHash } from 'node:crypto';

// SQL-only test fixtures. No simulator/provider request is made.
export async function paymentFixture(db) {
  const user = randomUUID(), org = randomUUID(), venue = randomUUID();
  const event = randomUUID(), show = randomUUID(), section = randomUUID(), seat = randomUUID();
  await db.query('INSERT INTO users (id,email,display_name,status) VALUES ($1,$2,$3,$4)', [user, `${user}@test.invalid`, 'Payment test', 'DISABLED']);
  await db.query('INSERT INTO organizers (id,name) VALUES ($1,$2)', [org, 'Payment test']);
  await db.query('INSERT INTO venues (id,name,city,organizer_id) VALUES ($1,$2,$3,$4)', [venue, 'Venue', 'City', org]);
  await db.query('INSERT INTO events (id,title,category,organizer_id) VALUES ($1,$2,$3,$4)', [event, 'Event', 'Talks', org]);
  await db.query('INSERT INTO shows (id,event_id,venue_id,organizer_id,starts_at) VALUES ($1,$2,$3,$4,$5)', [show, event, venue, org, '2030-01-01T18:00:00Z']);
  await db.query('INSERT INTO venue_sections (id,venue_id,name) VALUES ($1,$2,$3)', [section, venue, 'Stalls']);
  await db.query('INSERT INTO venue_seats (id,venue_id,section_id,row_label,seat_number) VALUES ($1,$2,$3,$4,$5)', [seat, venue, section, 'A', 1]);
  await db.query('INSERT INTO show_seats (show_id,venue_seat_id,venue_id,price_minor) VALUES ($1,$2,$3,$4)', [show, seat, venue, 75000]);
  async function reservation() {
    const { rows } = await db.query('INSERT INTO reservations (user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4) RETURNING *', [user, show, 75000, 'INR']);
    const res = rows[0];
    await db.query('INSERT INTO reservation_items (reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES ($1,$2,$3,$4,$5)', [res.id, show, seat, 75000, 'INR']);
    await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [res.id]);
    return res;
  }
  async function booking(res) {
    await db.query('UPDATE reservations SET status=$1,closed_at=clock_timestamp() WHERE id=$2', ['CONFIRMED', res.id]);
    const { rows } = await db.query('INSERT INTO bookings (reservation_id,user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4,$5) RETURNING id', [res.id, user, show, res.total_minor, 'INR']);
    const id = rows[0].id;
    await db.query('INSERT INTO booking_items (booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, res.id, show, seat, 75000, 'INR', 'Stalls', 'A', 1]);
    await db.query('UPDATE bookings SET sealed_at=clock_timestamp() WHERE id=$1', [id]);
    return id;
  }
  async function attempt(res) {
    const { rows } = await db.query('INSERT INTO payment_attempts (reservation_id,user_id,show_id,amount_minor,currency) VALUES ($1,$2,$3,$4,$5) RETURNING *', [res.id, user, show, res.total_minor, 'INR']);
    const row = rows[0];
    row.provider_payment_id = `sim_${row.id}`;
    await db.query('UPDATE payment_attempts SET provider_payment_id=$1 WHERE id=$2', [row.provider_payment_id, row.id]);
    return row;
  }
  async function capture(pay, bookingId = null) {
    await db.query('UPDATE payment_attempts SET status=$1,resolution=$2,booking_id=$3,succeeded_at=clock_timestamp() WHERE id=$4', ['SUCCEEDED', bookingId ? 'BOOKED' : 'REFUND_REQUIRED', bookingId, pay.id]);
  }
  async function refund(pay, reason = 'HOLD_EXPIRED') {
    return (await db.query('INSERT INTO refunds (payment_attempt_id,amount_minor,currency,reason) VALUES ($1,$2,$3,$4) RETURNING *', [pay.id, pay.amount_minor, pay.currency, reason])).rows[0];
  }
  async function eventRecord(pay, { eventId = randomUUID(), amount = pay.amount_minor, rejected = false } = {}) {
    const hash = createHash('sha256').update(JSON.stringify({ eventId, payment: pay.provider_payment_id, amount })).digest();
    return (await db.query(`INSERT INTO payment_events
      (provider_event_id,payment_attempt_id,provider_payment_id,kind,amount_minor,currency,payload_hash,verified_at,received_at,status,processed_at,rejection_code)
      VALUES ($1,$2,$3,'PAYMENT_SUCCEEDED',$4,'INR',$5,statement_timestamp(),statement_timestamp(),$6,
        CASE WHEN $6='REJECTED' THEN clock_timestamp() ELSE NULL END,
        CASE WHEN $6='REJECTED' THEN 'AMOUNT_MISMATCH' ELSE NULL END) RETURNING *`,
    [eventId, pay.id, pay.provider_payment_id, amount, hash, rejected ? 'REJECTED' : 'RECEIVED'])).rows[0];
  }
  return { user, show, seat, reservation, booking, attempt, capture, refund, eventRecord };
}
