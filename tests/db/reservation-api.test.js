import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { runExpiryBatch } from '../../apps/api/src/reservations/expiry.js';
import { reservationRequest as browserReservation, readAllCurrent } from '../../apps/web/src/reservations/client.js';
import { checkoutRequest, readPaymentHistory } from '../../apps/web/src/payments/client.js';

test('reservation/payment commands, retries and contention (real PostgreSQL, two APIs)', { timeout: 90000 }, async t => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original), servers = [], pools = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: 'https://seatledger.test' };
  let admin, schema, pool, show, seats, people;
  async function request(actor, path = '', { method = 'POST', body = {}, key = randomUUID(), instance = 0 } = {}) {
    return fetch(`http://127.0.0.1:${servers[instance].address().port}/api/reservations${path}`, { method,
      headers: { Cookie: actor.cookie, ...(method !== 'GET' ? { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': actor.csrf, 'Idempotency-Key': key } : {}) },
      ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
  }
  const hold = (actor, ids, options) => request(actor, '', { ...options, body: { showId: show.id, seatIds: ids } });
  async function timedHold(actor, seat, millisecondsUntilExpiry) {
    const ids = Array.isArray(seat) ? seat : [seat];
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=ANY($2::uuid[]) ORDER BY venue_seat_id FOR UPDATE', [show.id, ids]);
      const old = (await db.query(`WITH stamp AS MATERIALIZED
        (SELECT clock_timestamp()+$3::int*interval '1 millisecond'-interval '5 minutes' AS at)
        INSERT INTO reservations(user_id,show_id,currency,total_minor,created_at,expires_at)
        SELECT $1,$2,'INR',$4,at,at+interval '5 minutes' FROM stamp RETURNING id`, [actor.id, show.id, millisecondsUntilExpiry, 12345 * ids.length])).rows[0];
      await db.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) SELECT $1,$2,id,12345,'INR' FROM unnest($3::uuid[]) id", [old.id, show.id, ids]);
      await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [old.id]);
      await db.query("UPDATE show_seats stock SET state='HELD',reservation_id=r.id,expires_at=r.expires_at FROM reservations r WHERE r.id=$1 AND stock.show_id=$2 AND stock.venue_seat_id=ANY($3::uuid[])", [old.id, show.id, ids]);
      await db.query('COMMIT'); return old;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql', '011_reservation_recovery.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT'); const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`);
    for (let i = 0; i < 2; i++) { const p = createPool(url.toString()); pools.push(p); const s = createApp({ pool: p, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1'); servers.push(s); await new Promise((resolve, reject) => { s.once('listening', resolve); s.once('error', reject); }); }
    pool = pools[0]; people = [];
    async function newPerson() {
      const user = (await pool.query("INSERT INTO users(email,display_name,password_hash) VALUES($1,'Reservation fixture','fixture-not-used-for-login') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0];
      const raw = newToken(), csrf = csrfFor(raw, config.AUTH_SECRET);
      await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrf)]);
      return { id: user.id, cookie: `seatledger_session=${raw}`, csrf };
    }
    for (let i = 0; i < 100; i++) people.push(await newPerson());
    const org = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Hold fixture','APPROVED',$1,clock_timestamp()) RETURNING id", [people[0].id])).rows[0];
    const v = (await pool.query("INSERT INTO venues(name,city,organizer_id) VALUES('Hold room','Bengaluru',$1) RETURNING id", [org.id])).rows[0];
    const section = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [v.id])).rows[0];
    seats = (await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'A',n FROM generate_series(1,8) n RETURNING id", [v.id, section.id])).rows.map(r => r.id);
    const e = (await pool.query("INSERT INTO events(title,category,status,organizer_id) VALUES('Hold programme','Talks','PUBLISHED',$1) RETURNING id", [org.id])).rows[0];
    show = (await pool.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day') RETURNING id", [e.id, v.id, org.id])).rows[0];
    await pool.query("INSERT INTO show_seats(show_id,venue_id,venue_seat_id,price_minor,currency) SELECT $1,$2,id,12345,'INR' FROM venue_seats WHERE venue_id=$2", [show.id, v.id]);
    let seatNumber = 8;
    async function spareSeats(count = 1) {
      const ids = (await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'A',n FROM generate_series($3::int,$4::int) n RETURNING id", [v.id, section.id, seatNumber + 1, seatNumber + count])).rows.map(r => r.id);
      seatNumber += count;
      await pool.query("INSERT INTO show_seats(show_id,venue_id,venue_seat_id,price_minor,currency) SELECT $1,$2,id,12345,'INR' FROM unnest($3::uuid[]) id", [show.id, v.id, ids]);
      return ids;
    }
    const state = async id => (await pool.query('SELECT status,closed_at FROM reservations WHERE id=$1', [id])).rows[0];
    const stock = async ids => (await pool.query('SELECT venue_seat_id,state,reservation_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=ANY($2::uuid[]) ORDER BY venue_seat_id', [show.id, ids])).rows;
    const recover = (actor, query = { showId: show.id }, instance = 0) => request(actor, '/current?' + new URLSearchParams(query), { method: 'GET', instance });
    const browserContext = (actor, instance = 1) => ({ userId: actor.id, showId: show.id, csrfToken: actor.csrf,
      fetchImpl: (path, options) => fetch(`http://127.0.0.1:${servers[instance].address().port}${path}`, { ...options,
        headers: { ...options.headers, Cookie: actor.cookie, ...(options.method === 'POST' ? { Origin: config.PUBLIC_ORIGIN } : {}) } }) });
    const paymentCount = async id => (await pool.query(`SELECT
      (SELECT count(*)::int FROM payment_attempts WHERE reservation_id=$1) AS attempts,
      (SELECT count(*)::int FROM outbox_events o JOIN payment_attempts p ON p.id=o.payment_attempt_id WHERE p.reservation_id=$1) AS jobs`, [id])).rows[0];
    const paymentRead = (actor, id, instance = 0) => fetch(`http://127.0.0.1:${servers[instance].address().port}/api/payments/${id}`, { headers: { Cookie: actor.cookie } });
    const checkoutContext = (actor, reservationId) => ({ userId: actor.id, showId: show.id, reservationId, csrfToken: actor.csrf,
      fetchImpl: (path, options) => fetch(`http://127.0.0.1:${servers[1].address().port}${path}`, { ...options,
        headers: { ...options.headers, Cookie: actor.cookie, ...(options.method === 'POST' ? { Origin: config.PUBLIC_ORIGIN } : {}) } }) });

    await t.test('100 distinct users through two APIs produce one hold and 99 seat conflicts', async () => {
      const responses = await Promise.all(people.map((p, i) => hold(p, [seats[0]], { instance: i % 2 })));
      assert.equal(responses.filter(r => r.status === 201).length, 1);
      assert.equal(responses.filter(r => r.status === 409).length, 99, JSON.stringify(responses.map(r => r.status)));
      for (const r of responses.filter(r => r.status === 409)) assert.deepEqual(await r.json(), { error: 'SEATS_UNAVAILABLE', unavailableSeatIds: [seats[0]] });
      const allocations = (await pool.query("SELECT reservation_id FROM show_seats WHERE show_id=$1 AND state='HELD'", [show.id])).rows; assert.equal(allocations.length, 1);
    });
    await t.test('sorted same-key replay creates one agreement; changed payload and partial allocation fail', async () => {
      const key = randomUUID(), ids = [seats[1], seats[2]];
      const responses = await Promise.all([hold(people[0], ids, { key }), hold(people[0], [...ids].reverse(), { key, instance: 1 })]);
      for (const r of responses) assert.equal(r.status, 201, await r.clone().text());
      const first = await responses[0].json(); assert.deepEqual(await responses[1].json(), first); assert.equal(first.totalMinor, 24690);
      assert.equal(Date.parse(first.expiresAt) - Date.parse(first.createdAt), 300000);
      assert.equal((await hold(people[0], [seats[3]], { key })).status, 409);
      assert.equal((await hold(people[1], [seats[0], seats[3]])).status, 409);
      assert.equal((await pool.query('SELECT state FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2', [show.id, seats[3]])).rows[0].state, 'AVAILABLE');
      assert.equal((await request(people[1], '/' + first.id, { method: 'GET' })).status, 404);
      assert.equal((await request(people[1], '/' + first.id + '/release')).status, 404);
      const released = await request(people[0], '/' + first.id + '/release'); assert.equal(released.status, 200); assert.equal((await released.json()).status, 'RELEASED');
      const replay = await hold(people[0], ids, { key }); assert.equal((await replay.json()).id, first.id);
      assert.equal((await pool.query('SELECT state FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2', [show.id, ids[0]])).rows[0].state, 'AVAILABLE');
    });
    await t.test('expired stock is reclaimed without a worker and old release cannot clear the newer hold', async () => {
      const old = await timedHold(people[0], seats[4], -60000);
      const saved = await browserReservation('create', { ...browserContext(people[1]), command: {
        kind: 'create', userId: people[1].id, showId: show.id, key: randomUUID(), seatIds: [seats[4]] } });
      assert.equal(saved.status, 'ACTIVE');
      const release = await request(people[0], '/' + old.id + '/release'); assert.equal((await release.json()).status, 'EXPIRED');
      assert.equal((await pool.query('SELECT reservation_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2', [show.id, seats[4]])).rows[0].reservation_id, saved.id);
    });
    await t.test('current suspension stops sales but permits own release; client price and missing CSRF/key fail', async () => {
      const r = await hold(people[0], [seats[5]]); assert.equal(r.status, 201); const saved = await r.json();
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id]);
      assert.equal((await hold(people[1], [seats[6]])).status, 404);
      assert.equal((await request(people[0], '/' + saved.id + '/release')).status, 200);
      assert.equal((await request(people[0], '', { body: { showId: show.id, seatIds: [seats[7]], priceMinor: 1 } })).status, 400);
      assert.equal((await hold({ ...people[0], csrf: 'invalid' }, [seats[7]])).status, 403);
      assert.equal((await hold(people[0], [seats[7]], { key: '' })).status, 400);
    });
    await t.test('expiry is evaluated after an observed inventory lock wait', async () => {
      await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [org.id]);
      const old = await timedHold(people[0], seats[6], 900), db = await pool.connect(); let pending;
      try {
        await db.query('BEGIN');
        await db.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2 FOR UPDATE', [show.id, seats[6]]);
        const pid = (await db.query('SELECT pg_backend_pid() AS id')).rows[0].id;
        pending = hold(people[1], [seats[6]], { instance: 1 });
        let observed = false; const until = Date.now() + 1000;
        while (Date.now() < until) {
          if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting) { observed = true; break; }
          await pause(10);
        }
        assert.equal(observed, true, 'Must observe a real PostgreSQL waiter, not assume timing');
        assert.equal((await db.query('SELECT expires_at>clock_timestamp() AS live FROM reservations WHERE id=$1', [old.id])).rows[0].live, true,
          'The old hold must still be live after the API is observed waiting');
        await db.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (expires_at-clock_timestamp())))+0.03)
          FROM reservations WHERE id=$1`, [old.id]);
        await db.query('COMMIT');
        const response = await pending; assert.equal(response.status, 201, await response.clone().text());
        const saved = await response.json(); assert.notEqual(saved.id, old.id);
        assert.equal((await pool.query('SELECT reservation_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2', [show.id, seats[6]])).rows[0].reservation_id, saved.id);
      } finally { await db.query('ROLLBACK'); db.release(); if (pending) await pending.catch(() => {}); }
    });
    await t.test('expiry closes the old multi-seat agreement but preserves a reclaimed seat and immutable history', async () => {
      await runExpiryBatch(pool, { batchSize: 100 }); // Clear earlier expired fixture agreements.
      const ids = await spareSeats(2), old = await timedHold(people[0], ids, -60000);
      const response = await hold(people[1], [ids[0]]); assert.equal(response.status, 201); const newer = await response.json();
      const result = await runExpiryBatch(pool); assert.equal(result.expired, 1); assert.equal(result.releasedSeats, 1); assert.equal(result.failed, 0);
      const saved = await state(old.id); assert.equal(saved.status, 'EXPIRED'); assert.ok(saved.closed_at);
      const rows = await stock(ids); assert.equal(rows.find(r => r.venue_seat_id === ids[0]).reservation_id, newer.id);
      assert.equal(rows.find(r => r.venue_seat_id === ids[1]).state, 'AVAILABLE');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservation_items WHERE reservation_id=$1', [old.id])).rows[0].n, 2);
      assert.equal((await runExpiryBatch(pool)).expired, 0); assert.deepEqual(await state(old.id), saved);
    });
    await t.test('bounded batches, live holds and a busy inventory row are safe to retry', async () => {
      const ids = await spareSeats(3), old = await timedHold(people[0], ids[0], -60000);
      const second = await timedHold(people[0], ids[1], -30000), live = await timedHold(people[0], ids[2], 60000);
      for (const size of [0, 101, 1.5]) await assert.rejects(runExpiryBatch(pool, { batchSize: size }), TypeError);
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2 FOR UPDATE', [show.id, ids[0]]);
        const busy = await runExpiryBatch(pools[1], { batchSize: 1 });
        assert.equal(busy.selected, 1); assert.equal(busy.busy, 1); assert.equal(busy.expired, 0); assert.equal(busy.failed, 0);
        assert.equal((await state(old.id)).status, 'ACTIVE');
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      assert.equal((await runExpiryBatch(pool, { batchSize: 1 })).expired, 1);
      assert.equal((await state(second.id)).status, 'ACTIVE');
      assert.equal((await runExpiryBatch(pool, { batchSize: 1 })).expired, 1);
      assert.equal((await state(live.id)).status, 'ACTIVE'); assert.equal((await stock([ids[2]]))[0].state, 'HELD');
    });
    await t.test('two workers close one agreement once; a stock write failure rolls back the parent too', async () => {
      const ids = await spareSeats(2), old = await timedHold(people[0], ids[0], -60000);
      const results = await Promise.all(pools.map(p => runExpiryBatch(p)));
      assert.equal(results.reduce((n, r) => n + r.expired, 0), 1); assert.equal(results.reduce((n, r) => n + r.releasedSeats, 0), 1);
      assert.equal(results.reduce((n, r) => n + r.failed, 0), 0); assert.equal((await state(old.id)).status, 'EXPIRED');
      const failed = await timedHold(people[0], ids[1], -60000);
      await pool.query(`CREATE FUNCTION fail_expiry_stock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.state='AVAILABLE' AND OLD.state='HELD' THEN RAISE EXCEPTION 'fixture expiry write failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER fail_expiry_stock BEFORE UPDATE ON show_seats FOR EACH ROW EXECUTE FUNCTION fail_expiry_stock()');
      try {
        const result = await runExpiryBatch(pool); assert.equal(result.failed, 1); assert.equal(result.expired, 0);
        assert.equal((await state(failed.id)).status, 'ACTIVE'); assert.equal((await state(failed.id)).closed_at, null);
        assert.equal((await stock([ids[1]]))[0].reservation_id, failed.id);
      } finally { await pool.query('DROP TRIGGER fail_expiry_stock ON show_seats'); await pool.query('DROP FUNCTION fail_expiry_stock()'); }
      assert.equal((await runExpiryBatch(pool)).expired, 1);
    });
    await t.test('release racing expiry and reversed overlapping seat requests keep whole agreements', async () => {
      const ids = await spareSeats(2), old = await timedHold(people[0], ids, -60000);
      const [released, swept] = await Promise.all([request(people[0], '/' + old.id + '/release'), runExpiryBatch(pools[1])]);
      assert.equal(released.status, 200); assert.equal((await released.json()).status, 'EXPIRED'); assert.equal(swept.failed, 0);
      assert.ok((await stock(ids)).every(r => r.state === 'AVAILABLE' && r.reservation_id === null));
      const responses = await Promise.all([hold(people[1], ids), hold(people[2], [...ids].reverse(), { instance: 1 })]);
      assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
      const winner = await responses.find(r => r.status === 201).json(); assert.ok((await stock(ids)).every(r => r.reservation_id === winner.id));
    });
    await t.test('worker CLI one-shot and restart use durable state in a separate process', async () => {
      const ids = await spareSeats(), old = await timedHold(people[0], ids, -60000);
      const run = async () => {
        const result = await promisify(execFile)(process.execPath, ['--env-file-if-exists=.env', 'apps/api/src/reservations/expiry-worker.js', '--once'], {
          cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true, timeout: 10000,
          env: { ...process.env, DATABASE_URL: url.toString(), EXPIRY_BATCH_SIZE: '1', EXPIRY_POLL_MS: '1000' }
        });
        assert.equal(result.stderr, ''); const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(records[0].event, 'started'); assert.equal(records.at(-1).event, 'stopped');
        return records.find(r => r.event === 'batch');
      };
      assert.equal((await run()).expired, 1); const saved = await state(old.id);
      assert.equal((await run()).selected, 0); assert.deepEqual(await state(old.id), saved);
      assert.equal((await stock(ids))[0].state, 'AVAILABLE');
    });
    await t.test('owned recovery is a bounded deterministic list across APIs, including saved prices and the index', async () => {
      const actor = await newPerson(), ids = await spareSeats(23), created = [];
      for (const id of ids.slice(0, 21)) {
        const response = await hold(actor, [id]); assert.equal(response.status, 201); created.push(await response.json());
      }
      const multiResponse = await hold(actor, ids.slice(21)); assert.equal(multiResponse.status, 201); created.push(await multiResponse.json());
      const firstResponse = await recover(actor, { showId: show.id.toUpperCase() });
      assert.equal(firstResponse.status, 200); assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
      const first = await firstResponse.json(); assert.equal(first.showId, show.id); assert.equal(first.readOnly, true); assert.equal(first.paymentMode, 'simulated');
      assert.match(first.asOf, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      assert.equal(first.reservations.length, 20); assert.equal(first.nextCursor, first.reservations.at(-1).id);
      const second = await (await recover(actor, { showId: show.id, after: first.nextCursor }, 1)).json();
      assert.equal(second.reservations.length, 2); assert.equal(second.nextCursor, null);
      const actual = [...first.reservations, ...second.reservations], expected = created.sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(actual, expected); assert.equal(new Set(actual.map(r => r.id)).size, 22);
      const other = await newPerson(); assert.deepEqual((await (await recover(other)).json()).reservations, []);
      const unknown = await (await recover(actor, { showId: randomUUID() })).json(); assert.deepEqual(unknown.reservations, []);
      assert.equal(unknown.nextCursor, null);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=$1 AND indexname='reservations_current_user_show_idx'", [schema])).rows[0].n, 1);
      // History/index optimization must not add read-side lifecycle changes.
      assert.equal((await state(actual[0].id)).status, 'ACTIVE');
      // Real frontend JS transport through HTTP/PostgreSQL. Cookie/Origin adapter
      // substitutes browser behavior; this is not a DOM/browser journey check.
      const context = browserContext(actor);
      assert.deepEqual((await readAllCurrent(context)).reservations, expected);
      const releaseCommand = { kind: 'release', userId: actor.id, showId: show.id, key: randomUUID(), reservationId: expected[0].id };
      assert.equal((await browserReservation('release', { ...context, command: releaseCommand })).status, 'RELEASED');
      assert.equal((await browserReservation('release', { ...context, command: releaseCommand })).status, 'RELEASED');
      const extra = await spareSeats(2), createCommand = { kind: 'create', userId: actor.id, showId: show.id, key: randomUUID(), seatIds: extra.sort() };
      const saved = await browserReservation('create', { ...context, command: createCommand }); assert.equal(saved.totalMinor, 24690);
      assert.deepEqual(await browserReservation('create', { ...context, command: createCommand }), saved);
      const recovered = await readAllCurrent(context); assert.equal(recovered.reservations.length, 22); assert.ok(recovered.reservations.some(r => r.id === saved.id));
    });
    await t.test('recovery excludes expired, released and incomplete ownership; validates scope and permits suspended-owner recovery', async () => {
      const actor = await newPerson(), foreign = await newPerson(), ids = await spareSeats(6);
      const live = await timedHold(actor, ids[0], 60000), expired = await timedHold(actor, ids[1], -60000);
      const partial = await timedHold(actor, ids.slice(2, 4), 60000), released = await timedHold(actor, ids[4], 60000);
      await timedHold(foreign, ids[5], 60000);
      // Deliberate trusted-SQL drift: a live immutable agreement no longer owns every chair.
      await pool.query("UPDATE show_seats SET state='AVAILABLE',reservation_id=NULL,expires_at=NULL WHERE show_id=$1 AND venue_seat_id=$2", [show.id, ids[2]]);
      assert.equal((await request(actor, '/' + released.id + '/release')).status, 200);
      const before = await stock(ids);
      const read = await (await recover(actor)).json(); assert.deepEqual(read.reservations.map(r => r.id), [live.id]);
      assert.equal((await state(expired.id)).status, 'ACTIVE'); assert.equal((await state(partial.id)).status, 'ACTIVE');
      assert.deepEqual(await stock(ids), before, 'Recovery is read-only, not cleanup');
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id]);
      try { assert.deepEqual((await (await recover(actor)).json()).reservations.map(r => r.id), [live.id]); }
      finally { await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [org.id]); }
      for (const query of [{}, { showId: 'invalid' }, { showId: show.id, after: 'invalid' },
        { showId: show.id, userId: foreign.id }, { showId: show.id, limit: '1000' }]) assert.equal((await recover(actor, query)).status, 400);
      assert.equal((await request(actor, '/current?showId=' + show.id + '&showId=' + show.id, { method: 'GET' })).status, 400);
      assert.equal((await recover({ cookie: '' })).status, 401);
      await pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [actor.id]);
      assert.equal((await recover(actor)).status, 401);
    });
    await t.test('resolution closes an unclaimed command durably, preserves user/payload scope and never releases a hold', async () => {
      const actor = await newPerson(), other = await newPerson(), ids = await spareSeats(4), key = randomUUID();
      const command = { kind: 'create', userId: actor.id, showId: show.id, key, seatIds: [ids[0]] };
      const receipt = await browserReservation('resolve', { ...browserContext(actor), command });
      assert.deepEqual(receipt, { error: 'REQUEST_CLOSED', operation: 'reservation.create', requestKey: key, paymentMode: 'simulated' });
      for (const instance of [0, 1]) {
        const late = await hold(actor, [ids[0]], { key, instance }); assert.equal(late.status, 409); assert.deepEqual(await late.json(), receipt);
      }
      assert.equal((await stock([ids[0]]))[0].state, 'AVAILABLE');
      const changed = await hold(actor, [ids[1]], { key }); assert.equal(changed.status, 409); assert.equal((await changed.json()).error, 'IDEMPOTENCY_CONFLICT');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE user_id=$1', [actor.id])).rows[0].n, 0);
      const foreignScope = await hold(other, [ids[0]], { key }); assert.equal(foreignScope.status, 201);
      const heldResponse = await hold(actor, [ids[1]]); assert.equal(heldResponse.status, 201); const held = await heldResponse.json();
      const releaseKey = randomUUID(), releaseCommand = { kind: 'release', userId: actor.id, showId: show.id, key: releaseKey, reservationId: held.id };
      assert.equal((await browserReservation('resolve', { ...browserContext(actor), command: releaseCommand })).error, 'REQUEST_CLOSED');
      const lateRelease = await request(actor, '/' + held.id + '/release', { key: releaseKey }); assert.equal(lateRelease.status, 409);
      assert.equal((await stock([ids[1]]))[0].reservation_id, held.id); assert.equal((await state(held.id)).status, 'ACTIVE');
      const completedReleaseKey = randomUUID();
      assert.equal((await request(actor, '/' + held.id + '/release', { key: completedReleaseKey })).status, 200);
      assert.equal((await browserReservation('resolve', { ...browserContext(actor), command: { ...releaseCommand, key: completedReleaseKey } })).status, 'RELEASED');
      assert.equal((await request({ ...actor, csrf: 'invalid' }, '/resolve-create', { body: { showId: show.id, seatIds: [ids[2]] } })).status, 403);
      assert.equal((await request(actor, '/resolve-create', { body: { showId: show.id, seatIds: [ids[2]], userId: other.id } })).status, 400);
      // An injected receipt-write failure must not leave a tombstone or a claim.
      const failedKey = randomUUID();
      await pool.query(`CREATE FUNCTION fail_resolution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.response_body->>'error'='REQUEST_CLOSED' THEN RAISE EXCEPTION 'fixture resolution failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER fail_resolution BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION fail_resolution()');
      try {
        assert.equal((await request(actor, '/resolve-create', { key: failedKey, body: { showId: show.id, seatIds: [ids[2]] } })).status, 500);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id=$1 AND key=$2', [actor.id, failedKey])).rows[0].n, 0);
      } finally { await pool.query('DROP TRIGGER fail_resolution ON idempotency_keys'); await pool.query('DROP FUNCTION fail_resolution()'); }
      assert.equal((await hold(actor, [ids[2]], { key: failedKey })).status, 201);
    });
    await t.test('resolution waits for an observed in-flight original and replays the same committed outcome across APIs', async () => {
      const actor = await newPerson(), ids = await spareSeats(2), key = randomUUID(), blocker = await pool.connect(); let pending, resolving;
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2 FOR UPDATE', [show.id, ids[0]]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS id')).rows[0].id;
        pending = hold(actor, [ids[0]], { key }); let writerPid; const until = Date.now() + 1000;
        while (Date.now() < until) {
          writerPid = (await admin.query('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid])).rows[0]?.pid;
          if (writerPid) break; await pause(10);
        }
        assert.ok(writerPid, 'Observe the original holding its key while waiting for stock');
        resolving = request(actor, '/resolve-create', { key, body: { showId: show.id, seatIds: [ids[0]] }, instance: 1 });
        let observed = false; const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [writerPid])).rows[0].waiting) { observed = true; break; }
          await pause(10);
        }
        assert.equal(observed, true, 'Resolution must wait behind the original key, not race around it');
        await blocker.query('COMMIT');
        const [created, resolved] = await Promise.all([pending, resolving]); assert.equal(created.status, 201); assert.equal(resolved.status, 201);
        const saved = await created.json(); assert.deepEqual(await resolved.json(), saved);
        assert.equal((await stock([ids[0]]))[0].reservation_id, saved.id);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); if (resolving) await resolving.catch(() => {}); }
      const raceKey = randomUUID();
      const [created, resolved] = await Promise.all([hold(actor, [ids[1]], { key: raceKey }), request(actor, '/resolve-create', { key: raceKey, body: { showId: show.id, seatIds: [ids[1]] }, instance: 1 })]);
      assert.equal(created.status, resolved.status); assert.ok([201, 409].includes(created.status));
      assert.deepEqual(await created.json(), await resolved.json());
      const releaseResponse = await request(actor, '/' + (await stock([ids[0]]))[0].reservation_id + '/release'); assert.equal(releaseResponse.status, 200);
    });
    await t.test('an empty recovery during an observed in-flight create is not proof that the mutation failed', async () => {
      const actor = await newPerson(), ids = await spareSeats(), key = randomUUID(), blocker = await pool.connect(); let pending;
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2 FOR UPDATE', [show.id, ids[0]]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS id')).rows[0].id;
        pending = hold(actor, ids, { key }); let observed = false; const until = Date.now() + 1000;
        while (Date.now() < until) {
          if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting) { observed = true; break; }
          await pause(10);
        }
        assert.equal(observed, true);
        const during = await recover(actor, { showId: show.id }, 1); assert.equal(during.status, 200);
        assert.deepEqual((await during.json()).reservations, []);
        await blocker.query('COMMIT');
        const response = await pending; assert.equal(response.status, 201); const saved = await response.json();
        assert.deepEqual((await (await recover(actor, { showId: show.id }, 1)).json()).reservations, [saved]);
        const replay = await hold(actor, ids, { key, instance: 1 }); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), saved);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
    });
    await t.test('payment start uses saved prices and atomically queues one attempt across keys and APIs', async () => {
      const actor = await newPerson(), foreign = await newPerson(), ids = await spareSeats(3);
      const heldResponse = await hold(actor, ids.slice(0, 2)); assert.equal(heldResponse.status, 201); const held = await heldResponse.json();
      // Trusted fixture price drift must not change the immutable agreement.
      await pool.query('UPDATE show_seats SET price_minor=price_minor+5000 WHERE show_id=$1 AND venue_seat_id=ANY($2::uuid[])', [show.id, ids.slice(0, 2)]);
      const key = randomUUID(), path = '/' + held.id + '/payment-attempts';
      const responses = await Promise.all([request(actor, path, { key }), request(actor, path, { key, instance: 1 })]);
      for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
      const payment = await responses[0].json(); assert.deepEqual(await responses[1].json(), payment);
      assert.equal(payment.amountMinor, 24690); assert.equal(payment.currency, 'INR'); assert.equal(payment.reservationId, held.id);
      assert.equal(payment.status, 'CREATED'); assert.equal(payment.resolution, 'UNRESOLVED'); assert.equal(payment.bookingId, null); assert.equal(payment.paymentMode, 'simulated');
      for (const field of ['requestKey', 'request_key', 'userId', 'providerPaymentId']) assert.equal(Object.hasOwn(payment, field), false);
      const repeats = await Promise.all([request(actor, path), request(actor, path, { instance: 1 })]);
      for (const response of repeats) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), payment); }
      assert.deepEqual(await paymentCount(held.id), { attempts: 1, jobs: 1 });
      const job = (await pool.query(`SELECT o.kind,o.status,o.operation_key,p.request_key FROM outbox_events o
        JOIN payment_attempts p ON p.id=o.payment_attempt_id WHERE p.id=$1`, [payment.id])).rows[0];
      assert.equal(job.kind, 'PAYMENT_CREATE'); assert.equal(job.status, 'READY'); assert.equal(job.operation_key, job.request_key); assert.notEqual(job.operation_key, key);
      const detail = await paymentRead(actor, payment.id, 1); assert.equal(detail.headers.get('cache-control'), 'no-store'); assert.deepEqual(await detail.json(), payment);
      // Actual checkout JavaScript traverses signed-in HTTP and PostgreSQL; prices come from the saved agreement.
      const checkout = checkoutContext(actor, held.id), command = { userId: actor.id, showId: show.id, reservationId: held.id, key };
      assert.deepEqual(await checkoutRequest('agreement', checkout), held);
      assert.deepEqual(await checkoutRequest('start', { ...checkout, command, agreement: held }), payment);
      assert.deepEqual(await checkoutRequest('read', { ...checkout, paymentId: payment.id, agreement: held }), payment);
      assert.deepEqual(await readPaymentHistory({ ...checkout, agreement: held }), [payment]);
      await assert.rejects(checkoutRequest('read', { ...checkoutContext(foreign, held.id), paymentId: payment.id }), e => e.status === 404);
      const listed = await request(actor, path, { method: 'GET' }); assert.equal(listed.status, 200); const page = await listed.json(); assert.deepEqual(page.items, [payment]); assert.equal(page.nextCursor, null);
      assert.deepEqual((await (await request(actor, path + '?after=' + payment.id, { method: 'GET' })).json()).items, []);
      assert.equal((await paymentRead(foreign, payment.id)).status, 404);
      assert.equal((await request(foreign, path, { method: 'GET' })).status, 404); assert.equal((await request(foreign, path)).status, 404);
      const another = await (await hold(actor, [ids[2]])).json();
      const conflict = await request(actor, '/' + another.id + '/payment-attempts', { key }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, 'IDEMPOTENCY_CONFLICT');
      for (const body of [{ amountMinor: 1 }, { currency: 'INR' }, { provider: 'real' }, { paid: true }]) assert.equal((await request(actor, path, { body })).status, 400);
      assert.equal((await request({ ...actor, csrf: 'bad' }, path)).status, 403); assert.equal((await request(actor, path, { key: '' })).status, 400);
      assert.equal((await request(actor, path + '?extra=1')).status, 400);
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id]);
      try { assert.equal((await request(actor, path)).status, 404); assert.equal((await paymentRead(actor, payment.id)).status, 200); }
      finally { await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [org.id]); }
      // Failure is fixture state only: API never silently rebills this agreement.
      await pool.query("UPDATE payment_attempts SET status='FAILED' WHERE id=$1", [payment.id]);
      const failed = await request(actor, path); assert.equal(failed.status, 200); assert.equal((await failed.json()).status, 'FAILED'); assert.deepEqual(await paymentCount(held.id), { attempts: 1, jobs: 1 });
      assert.equal((await checkoutRequest('resolve', { ...checkout, command })).status, 'CREATED', 'Saved POST replay is historical');
      assert.equal((await readPaymentHistory({ ...checkout, agreement: held }))[0].status, 'FAILED', 'Current reads own the displayed outcome');
      assert.equal((await state(held.id)).status, 'ACTIVE');
    });
    await t.test('payment outbox failure rolls back attempt/key and explicit payment resolution fences late creation', async () => {
      const actor = await newPerson(), ids = await spareSeats(2), held = await timedHold(actor, ids[0], 60000), key = randomUUID();
      const path = '/' + held.id + '/payment-attempts';
      await pool.query(`CREATE FUNCTION fail_payment_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind='PAYMENT_CREATE' THEN RAISE EXCEPTION 'fixture payment queue failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER fail_payment_queue BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_payment_queue()');
      try {
        assert.equal((await request(actor, path, { key })).status, 500); assert.deepEqual(await paymentCount(held.id), { attempts: 0, jobs: 0 });
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id=$1 AND operation='payment.create' AND key=$2", [actor.id, key])).rows[0].n, 0);
      } finally { await pool.query('DROP TRIGGER fail_payment_queue ON outbox_events'); await pool.query('DROP FUNCTION fail_payment_queue()'); }
      const response = await request(actor, path, { key }); assert.equal(response.status, 201); const saved = await response.json();
      const resolve = await request(actor, '/' + held.id + '/resolve-payment', { key }); assert.equal(resolve.status, 201); assert.deepEqual(await resolve.json(), saved);
      const fresh = await timedHold(actor, ids[1], 60000), closedKey = randomUUID();
      const closed = await request(actor, '/' + fresh.id + '/resolve-payment', { key: closedKey }); assert.equal(closed.status, 409);
      assert.deepEqual(await closed.json(), { error: 'REQUEST_CLOSED', operation: 'payment.create', requestKey: closedKey, paymentMode: 'simulated' });
      assert.equal((await checkoutRequest('resolve', { ...checkoutContext(actor, fresh.id), command: {
        userId: actor.id, showId: show.id, reservationId: fresh.id, key: closedKey } })).error, 'REQUEST_CLOSED');
      const late = await request(actor, '/' + fresh.id + '/payment-attempts', { key: closedKey }); assert.equal(late.status, 409); assert.equal((await late.json()).error, 'REQUEST_CLOSED');
      assert.deepEqual(await paymentCount(fresh.id), { attempts: 0, jobs: 0 }); assert.equal((await state(fresh.id)).status, 'ACTIVE');
      // Legacy/storage-only rows are possible; do not pretend they are queued.
      await pool.query(`INSERT INTO payment_attempts(reservation_id,show_id,user_id,amount_minor,currency)
        SELECT id,show_id,user_id,total_minor,currency FROM reservations WHERE id=$1`, [fresh.id]);
      const orphan = await request(actor, '/' + fresh.id + '/payment-attempts'); assert.equal(orphan.status, 409); assert.equal((await orphan.json()).error, 'PAYMENT_REVIEW_REQUIRED');
      assert.deepEqual(await paymentCount(fresh.id), { attempts: 1, jobs: 0 });
    });
    await t.test('payment eligibility rejects expired/lost/released holds and rechecks expiry after observed stock wait and queue work', async () => {
      const actor = await newPerson(), ids = await spareSeats(6);
      const expired = await timedHold(actor, ids[0], -60000), released = await timedHold(actor, ids[1], 60000), partial = await timedHold(actor, ids.slice(2, 4), 60000);
      assert.equal((await request(actor, '/' + released.id + '/release')).status, 200);
      await pool.query("UPDATE show_seats SET state='AVAILABLE',reservation_id=NULL,expires_at=NULL WHERE show_id=$1 AND venue_seat_id=$2", [show.id, ids[2]]);
      for (const held of [expired, released, partial]) {
        const response = await request(actor, '/' + held.id + '/payment-attempts'); assert.equal(response.status, 409); assert.equal((await response.json()).error, 'RESERVATION_NOT_PAYABLE');
        assert.deepEqual(await paymentCount(held.id), { attempts: 0, jobs: 0 });
      }
      const waiting = await timedHold(actor, ids[4], 900), blocker = await pool.connect(); let pending;
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2 FOR UPDATE', [show.id, ids[4]]);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS id')).rows[0].id; pending = request(actor, '/' + waiting.id + '/payment-attempts', { instance: 1 });
        let observed = false; const until = Date.now() + 1000;
        while (Date.now() < until) {
          if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting) { observed = true; break; }
          await pause(10);
        }
        assert.equal(observed, true); assert.equal((await blocker.query('SELECT expires_at>clock_timestamp() AS live FROM reservations WHERE id=$1', [waiting.id])).rows[0].live, true);
        await blocker.query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (expires_at-clock_timestamp())))+0.03) FROM reservations WHERE id=$1", [waiting.id]);
        await blocker.query('COMMIT'); assert.equal((await pending).status, 409); assert.deepEqual(await paymentCount(waiting.id), { attempts: 0, jobs: 0 });
      } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
      const crossing = await timedHold(actor, ids[5], 800);
      await pool.query(`CREATE FUNCTION delay_payment_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind='PAYMENT_CREATE' THEN PERFORM pg_sleep(GREATEST(0,(SELECT EXTRACT(epoch FROM (r.expires_at-clock_timestamp()))
          FROM reservations r JOIN payment_attempts p ON p.reservation_id=r.id WHERE p.id=NEW.payment_attempt_id))+0.03); END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER delay_payment_queue BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION delay_payment_queue()');
      try { assert.equal((await request(actor, '/' + crossing.id + '/payment-attempts')).status, 409); assert.deepEqual(await paymentCount(crossing.id), { attempts: 0, jobs: 0 }); }
      finally { await pool.query('DROP TRIGGER delay_payment_queue ON outbox_events'); await pool.query('DROP FUNCTION delay_payment_queue()'); }
    });
    await t.test('payment start racing release never books or extends a hold; any queued work remains only CREATED', async () => {
      const actor = await newPerson(), ids = await spareSeats(), heldResponse = await hold(actor, ids); assert.equal(heldResponse.status, 201); const held = await heldResponse.json();
      const key = randomUUID();
      const [payment, release] = await Promise.all([request(actor, '/' + held.id + '/payment-attempts', { key }), request(actor, '/' + held.id + '/release', { instance: 1 })]);
      assert.equal(release.status, 200); assert.ok([201, 409].includes(payment.status));
      const count = await paymentCount(held.id); assert.deepEqual(count, { attempts: payment.status === 201 ? 1 : 0, jobs: payment.status === 201 ? 1 : 0 });
      if (payment.status === 201) { const saved = await payment.json(); assert.equal(saved.status, 'CREATED'); assert.equal(saved.bookingId, null); const replay = await request(actor, '/' + held.id + '/payment-attempts', { key }); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), saved); }
      const stored = (await pool.query('SELECT status,to_char(expires_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS expiry FROM reservations WHERE id=$1', [held.id])).rows[0];
      assert.equal(stored.status, 'RELEASED'); assert.equal(stored.expiry, held.expiresAt); assert.equal((await stock(ids))[0].state, 'AVAILABLE');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings WHERE reservation_id=$1', [held.id])).rows[0].n, 0);
    });
  } finally {
    for (const s of servers) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
    for (const p of pools) await p.end();
    if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); } await adminPool.end();
  }
});
