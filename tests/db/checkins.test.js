import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { ticketCredential, readTickets, issueTickets } from '../../apps/api/src/bookings/tickets.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { checkinRequest } from '../../apps/web/src/checkins/client.js';

test('staff check-in: two APIs, duplicate-safe admission, scoped recovery and atomic audit/deadline rollback', { timeout: 30000 }, async () => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original);
  let admin, schema, pool, secondPool;
  const servers = [], secret = 'cd'.repeat(32), origin = 'https://checkins.test';
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN');
    schema = await installReliabilitySchema(admin, 'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/015_admission_tickets.sql', import.meta.url), 'utf8'));
    async function actor() {
      const id = randomUUID(), token = newToken(), csrf = csrfFor(token, secret);
      await admin.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,'Staff','fixture-not-for-login')", [id, `${id}@test.invalid`]);
      await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [id, digest(token), digest(csrf)]);
      return { id, token, csrf };
    }
    const staff = [await actor(), await actor()], outsider = await actor();
    async function fixture(paid = true) {
      const f = await paymentFixture(admin), r = await f.reservation(), b = await f.booking(r);
      if (paid) { const p = await f.attempt(r); await f.capture(p, b); }
      await admin.query("UPDATE show_seats SET state='BOOKED',reservation_id=$1,booking_id=$2,expires_at=NULL WHERE show_id=$3", [r.id, b, f.show]);
      const { rows: [show] } = await admin.query('SELECT organizer_id,event_id FROM shows WHERE id=$1', [f.show]);
      await admin.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1", [show.organizer_id, staff[0].id]);
      await admin.query("UPDATE events SET status='PUBLISHED' WHERE id=$1", [show.event_id]);
      for (let i = 0; i < staff.length; i++) await admin.query('INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,$3)', [show.organizer_id, staff[i].id, i ? 'STAFF' : 'OWNER']);
      // SQL fixtures deliberately include an issued-but-unfunded record to prove
      // a genuine MAC/issuance row cannot bypass live payment eligibility.
      const ticket = (await admin.query(`INSERT INTO admission_tickets(booking_item_id,booking_id,show_id,issued_by)
        SELECT id,booking_id,show_id,$2 FROM booking_items WHERE booking_id=$1 RETURNING id`, [b, f.user])).rows[0].id;
      return { ...f, r, b, org: show.organizer_id, ticket, credential: ticketCredential(ticket, secret) };
    }
    const race = await fixture(), other = await fixture(), rollback = await fixture(), crossing = await fixture();
    const cancelled = await fixture(), expired = await fixture(), stockLost = await fixture(), unpaid = await fixture(false);
    const eventCancelled = await fixture();
    await admin.query('COMMIT');
    const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = createPool(url.toString()); secondPool = createPool(url.toString());
    const bases = [];
    for (let i = 0; i < 2; i++) {
      const server = createApp({ pool: i ? secondPool : pool, config: { NODE_ENV: 'test', AUTH_SECRET: secret, PUBLIC_ORIGIN: origin }, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
      servers.push(server); await new Promise(resolve => server.once('listening', resolve)); bases.push(`http://127.0.0.1:${server.address().port}`);
    }
    const path = f => `/api/organizers/${f.org}/shows/${f.show}/check-ins`;
    const headers = (who = staff[0]) => ({ Cookie: `seatledger_session=${who.token}`, Origin: origin,
      'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': who.csrf });
    const scan = (f, key = randomUUID(), who = staff[0], api = 0, changes = {}) => fetch(bases[api] + path(f), {
      method: 'POST', headers: headers(who), body: JSON.stringify({ credential: f.credential, requestKey: key, ...changes })
    });
    const recover = (f, key, who = staff[0]) => fetch(bases[0] + path(f) + '/' + key, { headers: headers(who) });
    const keys = Array.from({ length: 8 }, () => randomUUID());
    const responses = await Promise.all(keys.map((key, i) => scan(race, key, staff[i % 2], i % 2)));
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    assert.equal(responses.filter(r => r.status === 409).length, 7);
    const winner = responses.findIndex(r => r.status === 201), who = staff[winner % 2], key = keys[winner];
    const admitted = await responses[winner].json(); assert.equal(admitted.admissionGranted, true);
    assert.equal(admitted.checkin.ticketId, race.ticket); assert.equal(admitted.paymentMode, 'simulated');
    assert.equal(JSON.stringify(admitted).includes(race.credential), false);
    assert.equal(responses[winner].headers.get('cache-control'), 'no-store');
    assert.equal(responses[winner].headers.get('referrer-policy'), 'no-referrer');
    const replay = await scan(race, key, who); assert.equal(replay.status, 200);
    const replayBody = await replay.json(); assert.equal(replayBody.admissionGranted, false); assert.equal(replayBody.status, 'ALREADY_RECORDED');
    assert.deepEqual(replayBody.checkin, admitted.checkin);
    const recovered = await recover(race, key, who); assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), replayBody);
    assert.equal((await recover(race, key, staff[(winner + 1) % 2])).status, 404);
    assert.equal((await scan(race, key, staff[(winner + 1) % 2])).status, 409);
    assert.equal((await recover(race, randomUUID())).status, 404);
    assert.equal((await scan(other, key, who)).status, 409); // Same key, different ticket.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ticket_checkins')).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='ticket.checked_in'")).rows[0].n, 1);
    const ownerView = await readTickets(pool, race.user, race.b, secret);
    assert.equal(ownerView.tickets[0].status, 'USED'); assert.equal(ownerView.tickets[0].credential, null);
    assert.equal((await fetch(bases[0] + path(other), { method: 'POST', headers: { ...headers(), Cookie: '' }, body: JSON.stringify({ credential: other.credential, requestKey: randomUUID() }) })).status, 401);
    assert.equal((await scan(other, randomUUID(), outsider)).status, 404);
    assert.equal((await scan({ ...other, credential: race.credential })).status, 404); // Wrong selected show.
    const tampered = other.credential.slice(0, -1) + (other.credential.endsWith('A') ? 'B' : 'A');
    assert.equal((await scan(other, randomUUID(), staff[0], 0, { credential: tampered })).status, 404);
    assert.equal((await scan(other, randomUUID(), staff[0], 0, { amountMinor: 1 })).status, 400);
    assert.equal((await fetch(bases[0] + path(other), { method: 'POST', headers: { ...headers(), 'X-CSRF-Token': 'x'.repeat(43) }, body: JSON.stringify({ credential: other.credential, requestKey: randomUUID() }) })).status, 403);
    await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [other.org]);
    assert.equal((await scan(other)).status, 403);
    await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [other.org]);
    await pool.query('UPDATE organizer_memberships SET revoked_at=clock_timestamp() WHERE organizer_id=$1 AND user_id=$2', [other.org, staff[0].id]);
    assert.equal((await scan(other)).status, 404);
    await pool.query('UPDATE organizer_memberships SET revoked_at=NULL WHERE organizer_id=$1 AND user_id=$2', [other.org, staff[0].id]);

    await pool.query("UPDATE bookings SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=$1", [cancelled.b]);
    await pool.query("UPDATE shows SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.show]);
    await pool.query("UPDATE show_seats SET state='AVAILABLE',booking_id=NULL,reservation_id=NULL,expires_at=NULL WHERE show_id=$1", [stockLost.show]);
    for (const f of [cancelled, expired, stockLost, unpaid]) assert.equal((await scan(f)).status, 409);
    await pool.query("UPDATE events SET status='CANCELLED' WHERE id=(SELECT event_id FROM shows WHERE id=$1)", [eventCancelled.show]);
    assert.equal((await scan(eventCancelled)).status, 409);
    const voidView = await readTickets(pool, eventCancelled.user, eventCancelled.b, secret);
    assert.equal(voidView.tickets[0].status, 'VOID'); assert.equal(voidView.tickets[0].credential, null);
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await assert.rejects(issueTickets(connection, eventCancelled.user, eventCancelled.b), e => e.status === 409);
    } finally { await connection.query('ROLLBACK'); connection.release(); }
    // Even after expiry, a same-actor/key receipt is history, never a fresh entry.
    await pool.query("UPDATE shows SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [race.show]);
    assert.equal((await scan(race, key, who)).status, 200); assert.equal((await recover(race, key, who)).status, 200);

    await pool.query(`CREATE FUNCTION fail_checkin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.entity_id='${rollback.ticket}'::uuid THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER fail_checkin_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_checkin_audit()');
    const rollbackKey = randomUUID(); assert.equal((await scan(rollback, rollbackKey)).status, 500);
    assert.equal((await recover(rollback, rollbackKey)).status, 404);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ticket_checkins c JOIN booking_items i ON i.id=c.booking_item_id WHERE i.booking_id=$1', [rollback.b])).rows[0].n, 0);
    await pool.query('DROP TRIGGER fail_checkin_audit ON audit_events'); await pool.query('DROP FUNCTION fail_checkin_audit()');
    assert.equal((await scan(rollback, rollbackKey)).status, 201);
    const command = { userId: staff[0].id, organizationId: rollback.org, showId: rollback.show, requestKey: rollbackKey, ticketId: rollback.ticket };
    const client = { command, csrfToken: staff[0].csrf, fetchImpl: (path, options) => fetch(bases[0] + path, { ...options, headers: { ...headers(), ...options.headers } }) };
    const replayFromClient = await checkinRequest({ ...client, credential: rollback.credential });
    assert.equal(replayFromClient.admissionGranted, false);
    assert.deepEqual(await checkinRequest({ ...client, recover: true }), replayFromClient);

    await pool.query('CREATE SEQUENCE checkin_deadline_probe');
    await pool.query(`CREATE FUNCTION delay_checkin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.entity_id='${crossing.ticket}'::uuid THEN PERFORM nextval('checkin_deadline_probe');
        PERFORM pg_sleep(GREATEST(0,(SELECT EXTRACT(epoch FROM (starts_at-clock_timestamp())) FROM shows WHERE id='${crossing.show}'::uuid))+0.03);
      END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER delay_checkin_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION delay_checkin_audit()');
    await pool.query("UPDATE shows SET starts_at=clock_timestamp()+interval '900 milliseconds' WHERE id=$1", [crossing.show]);
    const crossingKey = randomUUID(); assert.equal((await scan(crossing, crossingKey)).status, 409);
    assert.equal((await pool.query('SELECT is_called FROM checkin_deadline_probe')).rows[0].is_called, true);
    assert.equal((await recover(crossing, crossingKey)).status, 404);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE operation_id=$1', [crossingKey])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ticket_checkins')).rows[0].n, 2);
    await assert.rejects(pool.query('DELETE FROM ticket_checkins WHERE request_key=$1', [key]), e => e.code === '23514');
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (pool) await pool.end();
    if (secondPool) await secondPool.end();
    if (admin) {
      await admin.query('ROLLBACK');
      if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      admin.release();
    }
    await adminPool.end();
  }
});
