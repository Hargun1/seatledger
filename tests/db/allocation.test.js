import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';

test('reservation and booking integrity (real PostgreSQL)', async t => {
  const pool = createPool(readConfig().DATABASE_URL);
  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    const user = randomUUID();
    const otherUser = randomUUID();
    const org = randomUUID();
    const venue = randomUUID();
    const event = randomUUID();
    const show = randomUUID();
    const otherShow = randomUUID();
    const section = randomUUID();
    await db.query('INSERT INTO users (id,email,display_name,status) VALUES ($1,$2,$3,$4),($5,$6,$3,$4)', [user, `${user}@test.invalid`, 'Test', 'DISABLED', otherUser, `${otherUser}@test.invalid`]);
    await db.query('INSERT INTO organizers (id,name) VALUES ($1,$2)', [org, 'Allocation tests']);
    await db.query('INSERT INTO venues (id,name,city,organizer_id) VALUES ($1,$2,$3,$4)', [venue, 'Venue', 'City', org]);
    await db.query('INSERT INTO events (id,title,category,organizer_id) VALUES ($1,$2,$3,$4)', [event, 'Event', 'Talks', org]);
    await db.query('INSERT INTO shows (id,event_id,venue_id,organizer_id,starts_at) VALUES ($1,$2,$3,$4,$5),($6,$2,$3,$4,$5)', [show, event, venue, org, '2030-01-01T18:00:00Z', otherShow]);
    await db.query('INSERT INTO venue_sections (id,venue_id,name) VALUES ($1,$2,$3)', [section, venue, 'Stalls']);
    const seats = Array.from({ length: 10 }, () => randomUUID());
    for (const [index, seat] of seats.entries()) {
      await db.query('INSERT INTO venue_seats (id,venue_id,section_id,row_label,seat_number) VALUES ($1,$2,$3,$4,$5)', [seat, venue, section, 'A', index + 1]);
      await db.query('INSERT INTO show_seats (show_id,venue_seat_id,venue_id,price_minor) VALUES ($1,$2,$3,$4),($5,$2,$3,$4)', [show, seat, venue, 75000, otherShow]);
    }
    async function check(name, work) {
      await t.test(name, async () => {
        await db.query('SAVEPOINT case_scope');
        try { await work(); }
        finally { await db.query('ROLLBACK TO SAVEPOINT case_scope'); await db.query('RELEASE SAVEPOINT case_scope'); }
      });
    }
    async function rejected(sql, values, code = '23514', constraint) {
      await db.query('SAVEPOINT invalid_write');
      try {
        await assert.rejects(db.query(sql, values), e => e.code === code && (!constraint || e.constraint === constraint));
      } finally { await db.query('ROLLBACK TO SAVEPOINT invalid_write'); await db.query('RELEASE SAVEPOINT invalid_write'); }
    }
    async function reservation({ selected = [seats[0]], total = selected.length * 75000, price = 75000, seal = true, addItems = true } = {}) {
      const id = randomUUID();
      const result = await db.query('INSERT INTO reservations (id,user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4,$5) RETURNING *, expires_at::text AS expires_at_exact', [id, user, show, total, 'INR']);
      if (addItems) for (const seat of selected) await db.query('INSERT INTO reservation_items (reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES ($1,$2,$3,$4,$5)', [id, show, seat, price, 'INR']);
      if (seal) await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [id]);
      return result.rows[0];
    }
    async function booking(res, { items = true, seal = true } = {}) {
      await db.query('UPDATE reservations SET status=$1,closed_at=clock_timestamp() WHERE id=$2', ['CONFIRMED', res.id]);
      const id = randomUUID();
      await db.query('INSERT INTO bookings (id,reservation_id,user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4,$5,$6)', [id, res.id, user, show, res.total_minor, 'INR']);
      if (items) await db.query(`INSERT INTO booking_items (booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number)
        SELECT $1,reservation_id,show_id,venue_seat_id,price_minor,currency,'Stalls','A',1 FROM reservation_items WHERE reservation_id=$2`, [id, res.id]);
      if (seal) await db.query('UPDATE bookings SET sealed_at=clock_timestamp() WHERE id=$1', [id]);
      return id;
    }
    const flush = () => db.query('SET CONSTRAINTS reservations_complete, bookings_complete IMMEDIATE');

    await check('allocation states require exactly the appropriate references', async () => {
      for (const state of ['UNKNOWN', 'HELD', 'BOOKED']) await rejected('UPDATE show_seats SET state=$1 WHERE show_id=$2', [state, show], '23514', 'show_seats_allocation_state');
      await rejected('UPDATE show_seats SET reservation_id=$1 WHERE show_id=$2', [randomUUID(), show], '23514', 'show_seats_allocation_state');
    });
    await check('a hold must reference its selected item and exact header expiry', async () => {
      const res = await reservation();
      const sql = 'UPDATE show_seats SET state=$1,reservation_id=$2,expires_at=$3 WHERE show_id=$4 AND venue_seat_id=$5';
      await db.query(sql, ['HELD', res.id, res.expires_at_exact, show, seats[0]]);
      await rejected(sql, ['HELD', res.id, res.expires_at_exact, show, seats[1]], '23503', 'show_seats_reservation_item_fk');
      await rejected(sql, ['HELD', res.id, new Date(res.expires_at.getTime() + 1000), show, seats[0]], '23503', 'show_seats_hold_expiry_fk');
      await flush();
    });
    await check('reservation items reject a different show or currency', async () => {
      const res = await reservation({ seal: false, addItems: false });
      const sql = 'INSERT INTO reservation_items (reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES ($1,$2,$3,$4,$5)';
      await rejected(sql, [res.id, otherShow, seats[0], 75000, 'INR'], '23503', 'reservation_items_header_fk');
      await rejected(sql, [res.id, show, seats[0], 75000, 'USD'], '23503', 'reservation_items_header_fk');
    });
    await check('duplicate selected seats are rejected', async () => {
      const res = await reservation({ seal: false });
      await rejected('INSERT INTO reservation_items (reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES ($1,$2,$3,$4,$5)', [res.id, show, seats[0], 75000, 'INR'], '23505');
    });
    await check('sealed agreements reject header edits and item edits/deletes/appends', async () => {
      const res = await reservation();
      await rejected('UPDATE reservations SET total_minor=1 WHERE id=$1', [res.id], '23514', 'reservations_immutable');
      await rejected('UPDATE reservations SET expires_at=expires_at+interval \'1 minute\' WHERE id=$1', [res.id], '23514', 'reservations_immutable');
      await rejected('UPDATE reservations SET sealed_at=NULL WHERE id=$1', [res.id], '23514', 'reservations_immutable');
      await rejected('UPDATE reservation_items SET price_minor=1 WHERE reservation_id=$1', [res.id], '23514', 'history_items_immutable');
      await rejected('DELETE FROM reservation_items WHERE reservation_id=$1', [res.id], '23514', 'history_items_immutable');
      await rejected('INSERT INTO reservation_items (reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES ($1,$2,$3,$4,$5)', [res.id, show, seats[1], 75000, 'INR'], '23514', 'history_items_sealed');
    });
    await check('deferred completion rejects an empty, unsealed or wrong-total reservation', async () => {
      for (const options of [{ addItems: false }, { seal: false }, { total: 1 }]) {
        await db.query('SAVEPOINT incomplete');
        await reservation(options);
        await rejected('SET CONSTRAINTS reservations_complete IMMEDIATE', [], '23514', 'reservations_complete');
        await db.query('ROLLBACK TO SAVEPOINT incomplete');
        await db.query('RELEASE SAVEPOINT incomplete');
      }
    });
    await check('more than eight seats and unsafe monetary totals are rejected', async () => {
      await reservation({ selected: seats.slice(0, 9) });
      await rejected('SET CONSTRAINTS reservations_complete IMMEDIATE', [], '23514', 'reservations_complete');
      await rejected('INSERT INTO reservations (user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4)', [user, show, '9007199254740992', 'INR'], '23514');
    });
    await check('database defaults create an exact five-minute hold', async () => {
      const res = await reservation();
      // Use PostgreSQL for sub-millisecond precision rather than JavaScript Date.
      const result = await db.query('SELECT extract(epoch FROM expires_at-created_at)::int AS seconds FROM reservations WHERE id=$1', [res.id]);
      assert.equal(result.rows[0].seconds, 300);
      await flush();
    });
    await check('booking header must match reservation customer, show, currency and total', async () => {
      const res = await reservation();
      const sql = 'INSERT INTO bookings (reservation_id,user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4,$5)';
      for (const values of [[otherUser, show, res.total_minor, 'INR'], [user, otherShow, res.total_minor, 'INR'], [user, show, 1, 'INR'], [user, show, res.total_minor, 'USD']]) {
        await rejected(sql, [res.id, ...values], '23503', 'bookings_reservation_fk');
      }
    });
    await check('one reservation cannot produce a second booking', async () => {
      const res = await reservation();
      await booking(res);
      await rejected('INSERT INTO bookings (reservation_id,user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4,$5)', [res.id, user, show, res.total_minor, 'INR'], '23505');
      await flush();
    });
    await check('booking items must preserve the agreed reservation price', async () => {
      const res = await reservation();
      const id = await booking(res, { items: false, seal: false });
      await rejected('INSERT INTO booking_items (booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, res.id, show, seats[0], 1, 'INR', 'Stalls', 'A', 1], '23503', 'booking_items_agreed_price_fk');
    });
    await check('booking completion rejects missing items and an unconfirmed reservation', async () => {
      await db.query('SAVEPOINT missing_items');
      const res = await reservation();
      await booking(res, { items: false });
      await rejected('SET CONSTRAINTS bookings_complete IMMEDIATE', [], '23514', 'bookings_complete');
      await db.query('ROLLBACK TO SAVEPOINT missing_items');
      await db.query('RELEASE SAVEPOINT missing_items');
      const active = await reservation();
      const id = randomUUID();
      await db.query('INSERT INTO bookings (id,reservation_id,user_id,show_id,total_minor,currency) VALUES ($1,$2,$3,$4,$5,$6)', [id, active.id, user, show, active.total_minor, 'INR']);
      await db.query(`INSERT INTO booking_items (booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number)
        SELECT $1,reservation_id,show_id,venue_seat_id,price_minor,currency,'Stalls','A',1 FROM reservation_items WHERE reservation_id=$2`, [id, active.id]);
      await db.query('UPDATE bookings SET sealed_at=clock_timestamp() WHERE id=$1', [id]);
      await rejected('SET CONSTRAINTS bookings_complete IMMEDIATE', [], '23514', 'bookings_complete');
    });
    await check('BOOKED inventory must reference the exact booking and reservation item', async () => {
      const res = await reservation();
      const id = await booking(res);
      const sql = 'UPDATE show_seats SET state=$1,reservation_id=$2,booking_id=$3,expires_at=NULL WHERE show_id=$4 AND venue_seat_id=$5';
      await db.query(sql, ['BOOKED', res.id, id, show, seats[0]]);
      await rejected(sql, ['BOOKED', res.id, randomUUID(), show, seats[0]], '23503', 'show_seats_booking_item_fk');
      const other = await reservation();
      await rejected(sql, ['BOOKED', other.id, id, show, seats[0]], '23503', 'show_seats_booking_item_fk');
      await rejected('UPDATE show_seats SET expires_at=clock_timestamp() WHERE show_id=$1 AND venue_seat_id=$2', [show, seats[0]], '23514', 'show_seats_allocation_state');
      await flush();
    });
    await check('terminal reservation and cancelled booking states cannot be revived', async () => {
      const expired = await reservation();
      await db.query('UPDATE reservations SET status=$1,closed_at=clock_timestamp() WHERE id=$2', ['EXPIRED', expired.id]);
      await rejected('UPDATE reservations SET status=$1 WHERE id=$2', ['CONFIRMED', expired.id], '23514', 'reservations_transition');
      const res = await reservation({ selected: [seats[1]] });
      const id = await booking(res);
      await db.query('UPDATE bookings SET status=$1,cancelled_at=clock_timestamp() WHERE id=$2', ['CANCELLED', id]);
      await rejected('UPDATE bookings SET status=$1,cancelled_at=NULL WHERE id=$2', ['CONFIRMED', id], '23514');
      await flush();
    });
    await check('cancellation allows another sale while old snapshots remain immutable', async () => {
      const first = await reservation();
      const oldBooking = await booking(first);
      await db.query('UPDATE show_seats SET state=$1,reservation_id=$2,booking_id=$3 WHERE show_id=$4 AND venue_seat_id=$5', ['BOOKED', first.id, oldBooking, show, seats[0]]);
      await db.query('UPDATE bookings SET status=$1,cancelled_at=clock_timestamp() WHERE id=$2', ['CANCELLED', oldBooking]);
      await db.query('UPDATE show_seats SET state=$1,reservation_id=NULL,booking_id=NULL,expires_at=NULL,price_minor=$2 WHERE show_id=$3 AND venue_seat_id=$4', ['AVAILABLE', 90000, show, seats[0]]);
      const second = await reservation({ price: 90000, total: 90000 });
      const newBooking = await booking(second);
      await db.query('UPDATE show_seats SET state=$1,reservation_id=$2,booking_id=$3 WHERE show_id=$4 AND venue_seat_id=$5', ['BOOKED', second.id, newBooking, show, seats[0]]);
      assert.deepEqual((await db.query('SELECT price_minor FROM booking_items WHERE booking_id=$1', [oldBooking])).rows, [{ price_minor: 75000 }]);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_items WHERE show_id=$1 AND venue_seat_id=$2', [show, seats[0]])).rows[0].n, 2);
      await rejected('UPDATE booking_items SET row_label=$1 WHERE booking_id=$2', ['Z', oldBooking], '23514', 'history_items_immutable');
      await rejected('DELETE FROM booking_items WHERE booking_id=$1', [oldBooking], '23514', 'history_items_immutable');
      await flush();
    });
    await check('failed aggregate validation can roll back the whole attempted allocation', async () => {
      await db.query('SAVEPOINT failed_hold');
      const invalid = await reservation({ total: 1 });
      await db.query('UPDATE show_seats SET state=$1,reservation_id=$2,expires_at=$3 WHERE show_id=$4 AND venue_seat_id=$5', ['HELD', invalid.id, invalid.expires_at_exact, show, seats[0]]);
      await assert.rejects(db.query('SET CONSTRAINTS reservations_complete IMMEDIATE'), e => e.code === '23514' && e.constraint === 'reservations_complete');
      await db.query('ROLLBACK TO SAVEPOINT failed_hold');
      await db.query('RELEASE SAVEPOINT failed_hold');
      const inventory = await db.query('SELECT state,reservation_id,booking_id,expires_at FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2', [show, seats[0]]);
      assert.deepEqual(inventory.rows[0], { state: 'AVAILABLE', reservation_id: null, booking_id: null, expires_at: null });
      assert.equal((await db.query('SELECT id FROM reservations WHERE id=$1', [invalid.id])).rowCount, 0);
    });
  } finally {
    try { if (db) { try { await db.query('ROLLBACK'); } finally { db.release(); } } }
    finally { await pool.end(); }
  }
});
