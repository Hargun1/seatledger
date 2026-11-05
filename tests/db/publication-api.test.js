import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { publicationRequest } from '../../apps/web/src/publication/client.js';

test('reviewed event publication is atomic, bounded and replay-safe (PostgreSQL + two APIs)', { timeout: 90000 }, async t => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original), servers = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: 'https://seatledger.test' };
  let admin, schema, pool, base, other, owner, staff, foreign, reviewer, org;
  const path = (event, suffix = 'publication', team = org.id) => `/organizers/${team}/events/${event.id}/${suffix}`;
  async function request(actor, url, { method = 'GET', body, target = base, headers = {} } = {}) {
    return fetch(target + '/api' + url, { method, headers: { Cookie: actor.cookie,
      ...(method !== 'GET' ? { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': actor.csrf } : {}), ...headers },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
  }
  async function expect(response, status, code) { assert.equal(response.status, status, await response.clone().text()); if (code) assert.deepEqual(await response.clone().json(), { error: code }); return response; }
  async function actor(role = 'CUSTOMER') {
    const user = (await pool.query("INSERT INTO users(email,display_name,password_hash,system_role) VALUES($1,'Publication fixture','fixture-only-not-for-login',$2) RETURNING id", [`${randomUUID()}@example.invalid`, role])).rows[0];
    const raw = newToken(), csrf = csrfFor(raw, config.AUTH_SECRET);
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrf)]);
    return { id: user.id, cookie: `seatledger_session=${raw}`, csrf };
  }
  async function team(actor) {
    const row = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Publisher team','APPROVED',$1,clock_timestamp()) RETURNING id", [reviewer.id])).rows[0];
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER')", [row.id, actor.id]); return row;
  }
  async function venue(seats = 3) {
    const row = (await pool.query("INSERT INTO venues(name,city,organizer_id) VALUES('Small stage','Bengaluru',$1) RETURNING id", [org.id])).rows[0];
    if (seats) { const section = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [row.id])).rows[0]; await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'A',n FROM generate_series(1,$3::int) n", [row.id, section.id, seats]); }
    return row;
  }
  async function event(venues, { count = 2 } = {}) {
    const row = (await pool.query("INSERT INTO events(title,category,organizer_id) VALUES('Reviewed talk','Talks',$1) RETURNING id", [org.id])).rows[0];
    row.shows = [];
    for (let i = 0; i < count; i++) { const v = venues[i % venues.length]; const show = (await pool.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at,base_price_minor,currency) VALUES($1,$2,$3,clock_timestamp()+interval '1 day'+$4*interval '1 hour',$5,'INR') RETURNING id,venue_id", [row.id, v.id, org.id, i, i * 10000])).rows[0]; row.shows.push(show); }
    return row;
  }
  const review = async e => (await expect(await request(owner, path(e)), 200)).json();
  const publish = (e, token, target = base, actor = owner) => request(actor, path(e, 'publish'), { method: 'POST', body: { reviewToken: token }, target });
  const inventory = async e => (await pool.query('SELECT ss.* FROM show_seats ss JOIN shows s ON s.id=ss.show_id WHERE s.event_id=$1 ORDER BY ss.show_id,ss.venue_seat_id', [e.id])).rows;
  const state = async e => (await pool.query('SELECT status,publication_revision,published_at,publication_token,publication_receipt FROM events WHERE id=$1', [e.id])).rows[0];
  async function scenario(name, fn) { let failed; await t.test(name, async () => { try { await fn(); } catch (e) { failed = e; throw e; } }); if (failed) throw failed; }
  async function waitForBlock(pid) { const until = Date.now() + 1000; while (Date.now() < until) { if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting) return; await pause(10); } assert.fail('Expected actual PostgreSQL blocking'); }
  async function blocked(sql, values, operation, change) {
    const db = await pool.connect(); let pending;
    try { await db.query('BEGIN'); await db.query(sql, values); const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; pending = operation(); await waitForBlock(pid); await change(db); await db.query('COMMIT'); return await pending; }
    finally { await db.query('ROLLBACK'); db.release(); if (pending) await pending.catch(() => {}); }
  }
  async function showCreate(e, v) { return request(owner, path(e, 'shows'), { method: 'POST', body: { venueId: v.id, expectedVenueRevision: 0, startsAt: new Date(Date.now() + 86400000).toISOString(), priceMinor: 75000, currency: 'INR' } }); }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT'); const database = new URL(original); database.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(database.toString());
    for (let i = 0; i < 2; i++) { const server = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1'); servers.push(server); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); }
    [base, other] = servers.map(s => `http://127.0.0.1:${s.address().port}`);
    reviewer = await actor('ADMIN'); owner = await actor(); staff = await actor(); foreign = await actor(); org = await team(owner);
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'STAFF')", [org.id, staff.id]);
    const a = await venue(3), b = await venue(2);
    await scenario('production JavaScript transport accepts real HTTP review, confirmation and reload receipt', async () => {
      const e = await event([a, b]), originalFetch = globalThis.fetch;
      globalThis.fetch = (url, options = {}) => typeof url === 'string' && url.startsWith('/api/')
        ? originalFetch(base + url, { ...options, headers: { ...options.headers, Cookie: owner.cookie, Origin: config.PUBLIC_ORIGIN } }) : originalFetch(url, options);
      try {
        const options = { organizationId: org.id, eventId: e.id, csrfToken: owner.csrf };
        assert.equal((await publicationRequest('status', options)).event.status, 'DRAFT');
        const reviewed = await publicationRequest('review', options), receipt = await publicationRequest('publish', { ...options, review: reviewed });
        const loaded = await publicationRequest('status', options); assert.deepEqual(loaded.receipt, receipt); assert.equal(loaded.event.status, 'PUBLISHED'); assert.equal(await inventory(e).then(rows => rows.length), 5);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.published'", [e.id])).rows[0].n, 1);
      } finally { globalThis.fetch = originalFetch; }
    });
    await scenario('status reads a scoped draft without evidence/token exposure or mutations', async () => {
      const e = await event([a]), before = await state(e), response = await expect(await request(owner, path(e, 'publication/status')), 200);
      assert.equal(response.headers.get('cache-control'), 'no-store'); const status = await response.json(); assert.equal(status.event.status, 'DRAFT'); assert.equal(status.event.publishedAt, null); assert.equal(status.receipt, null); assert.equal(status.organization.role, 'OWNER'); assert.equal(status.event.publicationRevision, 0); assert.equal(JSON.stringify(status).includes('savedToken'), false); assert.equal(JSON.stringify(status).includes('publication_token'), false); assert.deepEqual(await state(e), before);
      const staffStatus = await (await expect(await request(staff, path(e, 'publication/status')), 200)).json(); assert.equal(staffStatus.organization.role, 'STAFF');
      for (const actor of [foreign, reviewer]) await expect(await request(actor, path(e, 'publication/status')), 404);
    });
    await scenario('status recovers the committed publication receipt without repeating writes', async () => {
      const e = await event([a, b]), r = await review(e), receipt = await (await expect(await publish(e, r.reviewToken), 200)).json(), before = await inventory(e);
      const saved = await (await expect(await request(owner, path(e, 'publication/status')), 200)).json(); assert.equal(saved.event.status, 'PUBLISHED'); assert.deepEqual(saved.receipt, receipt); assert.equal(Date.parse(saved.event.publishedAt), Date.parse(receipt.event.publishedAt)); assert.deepEqual(await inventory(e), before);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.published'", [e.id])).rows[0].n, 1);
    });
    await scenario('legacy publication and cancelled historical receipt are reported without repair or re-publication', async () => {
      const legacy = await event([a]); await pool.query("UPDATE events SET status='PUBLISHED' WHERE id=$1", [legacy.id]); const old = await (await expect(await request(owner, path(legacy, 'publication/status')), 200)).json(); assert.equal(old.receipt, null); assert.equal(old.event.publishedAt, null); assert.deepEqual(await inventory(legacy), []);
      const e = await event([b]), r = await review(e), receipt = await (await expect(await publish(e, r.reviewToken), 200)).json(); await pool.query("UPDATE events SET status='CANCELLED' WHERE id=$1", [e.id]);
      const closed = await (await expect(await request(owner, path(e, 'publication/status')), 200)).json(); assert.equal(closed.event.status, 'CANCELLED'); assert.deepEqual(closed.receipt, receipt); await expect(await publish(e, r.reviewToken), 409, 'EVENT_NOT_EDITABLE');
    });
    await scenario('status rechecks event state committed while its SHARE lock waits', async () => {
      const e = await event([a]); const response = await blocked('SELECT id FROM events WHERE id=$1 FOR UPDATE', [e.id], () => request(owner, path(e, 'publication/status'), { target: other }), db => db.query("UPDATE events SET status='PUBLISHED' WHERE id=$1", [e.id]));
      const saved = await (await expect(response, 200)).json(); assert.equal(saved.event.status, 'PUBLISHED'); assert.equal(saved.receipt, null);
    });
    await scenario('review returns stable exact summary without inventory, receipt or state changes', async () => {
      const e = await event([a, b]), before = await state(e), r = await review(e), again = await review(e);
      assert.equal(r.reviewToken, again.reviewToken); assert.equal(r.inventoryCount, 5); assert.equal(r.shows.length, 2); assert.equal(r.event.status, 'DRAFT'); assert.equal(r.organization.role, 'OWNER');
      assert.match(r.shows[0].startsAt, /\.\d{6}Z$/); assert.deepEqual(await inventory(e), []); assert.deepEqual(await state(e), before);
      assert.equal((await request(owner, path(e))).headers.get('cache-control'), 'no-store');
    });
    await scenario('all shows receive exact physical seats and saved prices; state, receipt and audit commit together', async () => {
      const e = await event([a, b]), r = await review(e), response = await expect(await publish(e, r.reviewToken), 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const receipt = await response.json(), saved = await state(e), seats = await inventory(e); assert.equal(receipt.inventoryCount, 5); assert.equal(saved.status, 'PUBLISHED'); assert.ok(saved.published_at); assert.equal(saved.publication_token, r.reviewToken); assert.deepEqual(saved.publication_receipt, receipt); assert.equal(saved.publication_revision, 1);
      for (const show of r.shows) { const rows = seats.filter(s => s.show_id === show.id), physical = (await pool.query('SELECT id FROM venue_seats WHERE venue_id=$1 ORDER BY id', [show.venueId])).rows.map(s => s.id); assert.deepEqual(rows.map(s => s.venue_seat_id), physical); for (const seat of rows) { assert.equal(seat.state, 'AVAILABLE'); assert.equal(seat.price_minor, show.priceMinor); assert.equal(seat.currency, 'INR'); assert.equal(seat.reservation_id, null); assert.equal(seat.booking_id, null); } }
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.published'", [e.id])).rows[0].n, 1);
      await expect(await request(owner, `/organizers/${org.id}/events/${e.id}`, { method: 'PATCH', body: { title: 'Too late' } }), 409, 'EVENT_NOT_EDITABLE');
      await expect(await request(owner, path(e, 'shows/' + e.shows[0].id), { method: 'DELETE', body: { expectedRevision: 0 } }), 409, 'EVENT_NOT_EDITABLE');
    });
    await scenario('same-token publish retry replays the persisted receipt without duplicate inventory/audit', async () => {
      const e = await event([a]), r = await review(e), first = await (await expect(await publish(e, r.reviewToken), 200)).json(), before = await inventory(e);
      const db = await pool.connect();
      try {
        await db.query('BEGIN'); const seat = before[0]; await db.query('SELECT 1 FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2 FOR UPDATE', [seat.show_id, seat.venue_seat_id]);
        const reservation = (await db.query("INSERT INTO reservations(user_id,show_id,currency,total_minor) VALUES($1,$2,'INR',$3) RETURNING id", [owner.id, seat.show_id, seat.price_minor])).rows[0];
        await db.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES($1,$2,$3,$4,'INR')", [reservation.id, seat.show_id, seat.venue_seat_id, seat.price_minor]);
        await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [reservation.id]);
        await db.query("UPDATE show_seats SET state='HELD',reservation_id=$3,expires_at=(SELECT expires_at FROM reservations WHERE id=$3) WHERE show_id=$1 AND venue_seat_id=$2", [seat.show_id, seat.venue_seat_id, reservation.id]);
        await db.query('COMMIT');
      } finally { await db.query('ROLLBACK'); db.release(); }
      const held = await inventory(e); assert.equal(held.filter(seat => seat.state === 'HELD').length, 1);
      await pool.query("UPDATE shows SET starts_at=clock_timestamp()-interval '1 day' WHERE event_id=$1", [e.id]); // replay must not re-validate a now-past schedule or rebuild it
      assert.deepEqual(await (await expect(await publish(e, r.reviewToken, other), 200)).json(), first); assert.deepEqual(await inventory(e), held);
      const recovered = await (await expect(await request(owner, path(e, 'publication/status')), 200)).json(); assert.deepEqual(recovered.receipt, first); assert.deepEqual(await inventory(e), held);
      await expect(await publish(e, 'f'.repeat(64)), 409, 'EVENT_NOT_EDITABLE');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.published'", [e.id])).rows[0].n, 1);
    });
    await scenario('two simultaneous publishers get one committed receipt and one inventory set', async () => {
      const e = await event([b]), r = await review(e), responses = await Promise.all([publish(e, r.reviewToken), publish(e, r.reviewToken, other)]);
      assert.deepEqual(responses.map(r => r.status), [200, 200]); assert.deepEqual(await responses[0].json(), await responses[1].json()); assert.equal((await inventory(e)).length, 4);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.published'", [e.id])).rows[0].n, 1);
    });
    await scenario('staff may review; foreign members, global admins and malformed mutation inputs are denied', async () => {
      const e = await event([a]), r = await review(e); assert.equal((await (await expect(await request(staff, path(e)), 200)).json()).organization.role, 'STAFF'); await expect(await publish(e, r.reviewToken, base, staff), 403, 'OWNER_REQUIRED');
      for (const actor of [foreign, reviewer]) { await expect(await request(actor, path(e)), 404); await expect(await publish(e, r.reviewToken, base, actor), 404); }
      const foreignTeam = await team(foreign); await expect(await request(foreign, path(e, 'publication', foreignTeam.id)), 404);
      for (const body of [{}, { reviewToken: 'A'.repeat(64) }, { reviewToken: r.reviewToken, priceMinor: 1 }, { reviewToken: r.reviewToken, force: true }]) await expect(await request(owner, path(e, 'publish'), { method: 'POST', body }), 400);
      await expect(await request(owner, path(e, 'publish'), { method: 'POST', body: { reviewToken: r.reviewToken }, headers: { Origin: 'https://attacker.invalid' } }), 403);
      await expect(await request(owner, path(e, 'publish'), { method: 'POST', body: { reviewToken: r.reviewToken }, headers: { 'X-CSRF-Token': '' } }), 403);
    });
    await scenario('event metadata round trips invalidate old review; true no-ops keep it stable', async () => {
      const e = await event([a]), r = await review(e), p = `/organizers/${org.id}/events/${e.id}`;
      await expect(await request(owner, p, { method: 'PATCH', body: { title: 'Reviewed talk' } }), 200); assert.equal((await review(e)).reviewToken, r.reviewToken);
      for (const title of ['Changed', 'Reviewed talk']) await expect(await request(owner, p, { method: 'PATCH', body: { title } }), 200);
      await expect(await publish(e, r.reviewToken), 409, 'PUBLICATION_STALE'); assert.equal((await state(e)).publication_revision, 2); assert.deepEqual(await inventory(e), []);
    });
    await scenario('adding then deleting a show invalidates review even when the final schedule is identical', async () => {
      const e = await event([a]), r = await review(e), added = await (await expect(await showCreate(e, a), 201)).json();
      await expect(await request(owner, path(e, 'shows/' + added.id), { method: 'DELETE', body: { expectedRevision: 0 } }), 200);
      await expect(await publish(e, r.reviewToken), 409, 'PUBLICATION_STALE'); assert.equal((await state(e)).publication_revision, 2);
    });
    await scenario('price changes and exact physical-seat changes invalidate the reviewed snapshot', async () => {
      const v = await venue(), e = await event([v]), r = await review(e);
      await expect(await request(owner, path(e, 'shows/' + e.shows[0].id), { method: 'PATCH', body: { expectedRevision: 0, priceMinor: 777 } }), 200); await expect(await publish(e, r.reviewToken), 409, 'PUBLICATION_STALE');
      const next = await review(e); await pool.query("UPDATE venue_seats SET row_label='Z' WHERE venue_id=$1", [v.id]); await expect(await publish(e, next.reviewToken), 409, 'PUBLICATION_STALE');
      const changed = await review(e); await pool.query("UPDATE shows SET starts_at=starts_at+interval '1 microsecond' WHERE id=$1", [e.shows[0].id]); await expect(await publish(e, changed.reviewToken), 409, 'PUBLICATION_STALE');
    });
    await scenario('empty, non-scheduled, unpriced, past and already-inventoried drafts never partially publish', async () => {
      const empty = await event([a], { count: 0 }); await expect(await request(owner, path(empty)), 409, 'EVENT_SHOWS_REQUIRED');
      for (const [sql, code] of [["status='CANCELLED'", 'SHOW_NOT_EDITABLE'], ["base_price_minor=NULL,currency=NULL", 'SHOW_PRICE_REQUIRED'], ["starts_at=clock_timestamp()-interval '1 day'", 'SHOW_TIME_PASSED']]) {
        const e = await event([a]); await pool.query(`UPDATE shows SET ${sql} WHERE id=$1`, [e.shows[0].id]); await expect(await request(owner, path(e)), 409, code); assert.equal((await state(e)).status, 'DRAFT'); assert.deepEqual(await inventory(e), []);
      }
      const e = await event([b]), r = await review(e); await pool.query('INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) SELECT $1,id,venue_id,1 FROM venue_seats WHERE venue_id=$2', [e.shows[0].id, b.id]); const before = await inventory(e); await expect(await publish(e, r.reviewToken), 409, 'SHOW_IN_USE'); assert.deepEqual(await inventory(e), before);
      const noPlan = await venue(0), missing = await event([noPlan]); await expect(await request(owner, path(missing)), 409, 'VENUE_LAYOUT_REQUIRED');
    });
    await scenario('audit failure rolls back every inserted seat, event state and publication receipt', async () => {
      const e = await event([a, b]), r = await review(e), before = await state(e);
      await pool.query(`CREATE FUNCTION fail_publish_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='event.published' THEN RAISE EXCEPTION 'injected publication audit failure'; END IF; RETURN NEW; END $$`); await pool.query('CREATE TRIGGER fail_publish_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_publish_test()');
      try { await expect(await publish(e, r.reviewToken), 500, 'INTERNAL_ERROR'); assert.deepEqual(await state(e), before); assert.deepEqual(await inventory(e), []); }
      finally { await pool.query('DROP TRIGGER fail_publish_test ON audit_events'); await pool.query('DROP FUNCTION fail_publish_test()'); }
      await expect(await publish(e, r.reviewToken), 200);
    });
    await scenario('a mid-inventory insert failure rolls back earlier seats from the same statement', async () => {
      const e = await event([a, b]), r = await review(e), before = await state(e);
      await pool.query(`CREATE FUNCTION fail_inventory_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.show_id='${e.shows.map(s => s.id).sort().at(-1)}'::uuid THEN RAISE EXCEPTION 'injected inventory failure'; END IF; RETURN NEW; END $$`); // locally generated fixture ID only
      await pool.query('CREATE TRIGGER fail_inventory_test BEFORE INSERT ON show_seats FOR EACH ROW EXECUTE FUNCTION fail_inventory_test()');
      try { await expect(await publish(e, r.reviewToken), 500, 'INTERNAL_ERROR'); assert.deepEqual(await inventory(e), []); assert.deepEqual(await state(e), before); }
      finally { await pool.query('DROP TRIGGER fail_inventory_test ON show_seats'); await pool.query('DROP FUNCTION fail_inventory_test()'); }
    });
    await scenario('metadata changed while publisher waits is observed after the event lock', async () => {
      const e = await event([a]), r = await review(e);
      const response = await blocked('SELECT id FROM events WHERE id=$1 FOR UPDATE', [e.id], () => publish(e, r.reviewToken, other), db => db.query("UPDATE events SET title='Changed during wait',publication_revision=publication_revision+1 WHERE id=$1", [e.id])); await expect(response, 409, 'PUBLICATION_STALE'); assert.deepEqual(await inventory(e), []);
    });
    await scenario('time is rechecked after all venue locks and late-start copying rolls back', async () => {
      const v = await venue(), e = await event([v]), r = await review(e);
      const response = await blocked('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [v.id], () => publish(e, r.reviewToken, other), db => db.query("UPDATE shows SET starts_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [e.shows[0].id])); await expect(response, 409, 'SHOW_TIME_PASSED'); assert.deepEqual(await inventory(e), []);
      // Stay below createPool's 2000ms query budget while deliberately crossing
      // the start during the insert. A 2s fixture delay tests driver timeout.
      const later = await event([v], { count: 1 }); await pool.query("UPDATE shows SET starts_at=clock_timestamp()+interval '1 second' WHERE event_id=$1", [later.id]); const reviewed = await review(later);
      await pool.query(`CREATE FUNCTION delay_inventory_test() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE remaining double precision; BEGIN SELECT EXTRACT(EPOCH FROM (starts_at-clock_timestamp())) INTO remaining FROM shows WHERE id=NEW.show_id; PERFORM pg_sleep(GREATEST(remaining,0)+0.02); RETURN NEW; END $$`); await pool.query('CREATE TRIGGER delay_inventory_test BEFORE INSERT ON show_seats FOR EACH ROW EXECUTE FUNCTION delay_inventory_test()');
      try { await expect(await publish(later, reviewed.reviewToken), 409, 'SHOW_TIME_PASSED'); assert.deepEqual(await inventory(later), []); assert.equal((await state(later)).status, 'DRAFT'); }
      finally { await pool.query('DROP TRIGGER delay_inventory_test ON show_seats'); await pool.query('DROP FUNCTION delay_inventory_test()'); }
    });
    await scenario('publisher versus concurrent schedule creation cannot omit an accepted show', async () => {
      const e = await event([a]), r = await review(e), responses = await Promise.all([publish(e, r.reviewToken), showCreate(e, b)]), statuses = responses.map(r => r.status);
      assert.ok((statuses[0] === 200 && statuses[1] === 409) || (statuses[0] === 409 && statuses[1] === 201), JSON.stringify(statuses));
      if (statuses[0] === 200) { await expect(responses[1], 409, 'EVENT_NOT_EDITABLE'); assert.equal((await inventory(e)).length, 6); } else { await expect(responses[0], 409, 'PUBLICATION_STALE'); assert.deepEqual(await inventory(e), []); }
    });
    await scenario('two events sharing venues in reversed input order publish without lock inversion', async () => {
      const x = await event([a, b]), y = await event([b, a]), rx = await review(x), ry = await review(y);
      const responses = await Promise.all([publish(x, rx.reviewToken), publish(y, ry.reviewToken, other)]); for (const response of responses) await expect(response, 200); assert.equal((await inventory(x)).length, 5); assert.equal((await inventory(y)).length, 5);
    });
    await scenario('twenty 500-seat shows initialize 10000 exact rows; excess schedules are rejected', async () => {
      const v = await venue(500), e = await event([v], { count: 20 }), r = await review(e); assert.equal(r.inventoryCount, 10000);
      const receipt = await (await expect(await publish(e, r.reviewToken), 200)).json(); assert.equal(receipt.inventoryCount, 10000); assert.equal((await inventory(e)).length, 10000);
      const excessive = await event([a], { count: 21 }); await expect(await request(owner, path(excessive)), 409, 'PUBLICATION_TOO_LARGE');
      const atCap = await event([a], { count: 20 }); await expect(await showCreate(atCap, a), 409, 'EVENT_SHOW_LIMIT');
      const oversized = await venue(501), invalid = await event([oversized]); await expect(await request(owner, path(invalid)), 409, 'LAYOUT_TOO_LARGE');
    });
    await scenario('suspension/revocation and lock timeout fail closed without inventory writes', async () => {
      const e = await event([a]), r = await review(e);
      let response = await blocked('SELECT id FROM organizers WHERE id=$1 FOR UPDATE', [org.id], () => publish(e, r.reviewToken, other), db => db.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id])); await expect(response, 403, 'ORGANIZER_NOT_APPROVED'); await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [org.id]);
      const control = await pool.connect(); let pending;
      try { await control.query('BEGIN'); await control.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [e.id]); const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; pending = publish(e, r.reviewToken, other); await waitForBlock(pid); await expect(await pending, 503, 'ACCESS_BUSY'); }
      finally { await control.query('ROLLBACK'); control.release(); if (pending) await pending.catch(() => {}); }
      await pool.query('UPDATE organizer_memberships SET revoked_at=clock_timestamp() WHERE organizer_id=$1 AND user_id=$2', [org.id, staff.id]); await expect(await request(staff, path(e)), 404); assert.deepEqual(await inventory(e), []);
    });
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end(); if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); } await adminPool.end();
  }
});
