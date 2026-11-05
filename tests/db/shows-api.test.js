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

test('draft shows: owned scheduling, revisions, freeze and real database races through two APIs', { timeout: 60000 }, async t => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original), servers = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: 'https://seatledger.test' };
  let admin, schema, pool, base, other, owner, staff, stranger, reviewer, org, event, venue, scheduled;
  const root = (eventId = event?.id, organizationId = org?.id) => `/organizers/${organizationId}/events/${eventId}/shows`;
  const url = id => root() + '/' + id;
  async function request(actor, path, { method = 'GET', body, target = base, headers = {} } = {}) {
    return fetch(target + '/api' + path, { method, headers: { Cookie: actor.cookie,
      ...(method !== 'GET' ? { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': actor.csrf } : {}), ...headers },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
  }
  async function expect(response, status, code) {
    assert.equal(response.status, status, await response.clone().text());
    if (code) assert.deepEqual(await response.clone().json(), { error: code });
    return response;
  }
  const future = () => new Date(Date.now() + 86400000).toISOString();
  const input = () => ({ venueId: venue.id, expectedVenueRevision: 0, startsAt: future(), priceMinor: 75000, currency: 'INR' });
  const create = async (body = input(), target = base) => request(owner, root(), { method: 'POST', body, target });
  const patch = (id, body, target = base) => request(owner, url(id), { method: 'PATCH', body, target });
  const remove = (id, revision) => request(owner, url(id), { method: 'DELETE', body: { expectedRevision: revision } });
  const read = async id => (await expect(await request(owner, url(id)), 200)).json();
  async function actor(role = 'CUSTOMER') {
    const user = (await pool.query("INSERT INTO users(email,display_name,password_hash,system_role) VALUES($1,'Show fixture','fixture-only-not-for-login',$2) RETURNING id", [`${randomUUID()}@example.invalid`, role])).rows[0];
    const raw = newToken(), csrf = csrfFor(raw, config.AUTH_SECRET);
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrf)]);
    return { id: user.id, cookie: `seatledger_session=${raw}`, csrf };
  }
  async function team(actor) {
    const row = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Show team','APPROVED',$1,clock_timestamp()) RETURNING id", [reviewer.id])).rows[0];
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER')", [row.id, actor.id]); return row;
  }
  async function newEvent(organizationId = org.id) { return (await pool.query("INSERT INTO events(title,category,organizer_id) VALUES('Draft talk','Talks',$1) RETURNING id", [organizationId])).rows[0]; }
  async function newVenue(organizationId = org.id, seats = 3) {
    const row = (await pool.query("INSERT INTO venues(name,city,organizer_id) VALUES('Show room','Bengaluru',$1) RETURNING id", [organizationId])).rows[0];
    if (seats) {
      const section = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [row.id])).rows[0];
      await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'A',n FROM generate_series(1,$3::int) n", [row.id, section.id, seats]);
    }
    return row;
  }
  async function scenario(name, work) { let failure; await t.test(name, async () => { try { await work(); } catch (e) { failure = e; throw e; } }); if (failure) throw failure; }
  async function waitForBlock(pid) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting) return;
      await pause(10);
    }
    assert.fail('Expected an observed PostgreSQL lock wait');
  }
  async function withBlockedVenue(id, work) {
    const db = await pool.connect();
    try { await db.query('BEGIN'); await db.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [id]); await work(db, (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); }
    finally { await db.query('ROLLBACK'); db.release(); }
  }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT');
    const database = new URL(original); database.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(database.toString());
    for (let i = 0; i < 2; i++) { const server = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1'); servers.push(server); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); }
    [base, other] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
    reviewer = await actor('ADMIN'); owner = await actor(); staff = await actor(); stranger = await actor(); org = await team(owner);
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'STAFF')", [org.id, staff.id]); event = await newEvent(); venue = await newVenue();

    await scenario('creation saves a scoped revision-zero show and audit but creates no inventory', async () => {
      scheduled = await (await expect(await create(), 201)).json(); assert.equal(scheduled.revision, 0); assert.equal(scheduled.priceMinor, 75000); assert.equal(scheduled.currency, 'INR'); assert.equal(scheduled.status, 'SCHEDULED'); assert.equal(scheduled.venueId, venue.id); assert.equal(scheduled.eventId, event.id);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM show_seats WHERE show_id=$1', [scheduled.id])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='show.created'", [scheduled.id])).rows[0].n, 1);
      await expect(await request(owner, `/organizers/${org.id}/venues/${venue.id}/layout`, { method: 'PUT', body: { expectedRevision: 0, sections: [{ name: 'Other', rows: [{ label: 'B', seats: 2 }] }] } }), 409, 'VENUE_IN_USE');
    });
    await scenario('strict HTTP inputs reject local/invalid time, missing revisions, injected scope and price coercion', async () => {
      for (const extra of [{ startsAt: '2030-10-30T18:00:00' }, { startsAt: '2030-02-30T18:00:00Z' }, { expectedVenueRevision: '0' }, { priceMinor: '75000' }, { currency: 'USD' }, { organizerId: org.id }, { status: 'PUBLISHED' }]) await expect(await create({ ...input(), ...extra }), 400, 'INVALID_REQUEST');
      await expect(await patch(scheduled.id, { priceMinor: 1 }), 400);
      await expect(await request(owner, root('invalid')), 404);
      await expect(await request(owner, root() + '?limit=51'), 400);
      await expect(await create({ ...input(), startsAt: '2000-01-01T00:00:00Z' }), 409, 'SHOW_TIME_PASSED');
    });
    await scenario('staff read but cannot write; other tenants and membership-free admins are denied', async () => {
      const listing = await (await expect(await request(staff, root()), 200)).json(); assert.equal(listing.organization.role, 'STAFF');
      await expect(await request(staff, url(scheduled.id)), 200);
      for (const [path, method, body] of [[root(), 'POST', input()], [url(scheduled.id), 'PATCH', { expectedRevision: 0, priceMinor: 1 }], [url(scheduled.id), 'DELETE', { expectedRevision: 0 }]]) await expect(await request(staff, path, { method, body }), 403, 'OWNER_REQUIRED');
      for (const actor of [stranger, reviewer]) { await expect(await request(actor, root()), 404); await expect(await request(actor, url(scheduled.id), { method: 'PATCH', body: { expectedRevision: 0, priceMinor: 1 } }), 404); }
      const foreign = await team(stranger), foreignEvent = await newEvent(foreign.id), foreignVenue = await newVenue(foreign.id);
      await expect(await request(owner, root(foreignEvent.id)), 404);
      await expect(await create({ ...input(), venueId: foreignVenue.id }), 404);
      await expect(await request(stranger, root(event.id, foreign.id) + '/' + scheduled.id), 404);
      const another = await newEvent(); await expect(await request(owner, root(another.id) + '/' + scheduled.id), 404);
    });
    await scenario('creation requires a current bounded populated venue layout', async () => {
      await expect(await create({ ...input(), expectedVenueRevision: 1 }), 409, 'VENUE_STALE');
      const empty = await newVenue(org.id, 0); await expect(await create({ ...input(), venueId: empty.id }), 409, 'VENUE_LAYOUT_REQUIRED');
      await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Empty')", [empty.id]); await expect(await create({ ...input(), venueId: empty.id }), 409, 'VENUE_LAYOUT_REQUIRED');
      const oversized = await newVenue(org.id, 501); await expect(await create({ ...input(), venueId: oversized.id }), 409, 'LAYOUT_TOO_LARGE');
    });
    await scenario('list pagination is bounded and detail carries checked organization/event context', async () => {
      await expect(await create({ ...input(), priceMinor: 0 }), 201);
      const response = await expect(await request(owner, root() + '?limit=1'), 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const first = await response.json(); assert.equal(first.items.length, 1); assert.ok(first.nextCursor); assert.equal(first.event.id, event.id);
      const second = await (await expect(await request(owner, root() + '?limit=1&after=' + first.nextCursor), 200)).json(); assert.notEqual(second.items[0].id, first.items[0].id);
      const detail = await read(scheduled.id); assert.equal(detail.organization.id, org.id); assert.equal(detail.inUse, false);
    });
    await scenario('patch changes the observed revision once; unchanged input is an audit-free no-op', async () => {
      const updated = await (await expect(await patch(scheduled.id, { expectedRevision: 0, priceMinor: 80000 }), 200)).json(); assert.equal(updated.revision, 1);
      const same = await (await expect(await patch(scheduled.id, { expectedRevision: 1, startsAt: updated.startsAt, priceMinor: 80000 }), 200)).json(); assert.equal(same.revision, 1);
      await expect(await patch(scheduled.id, { expectedRevision: 0, priceMinor: 100 }), 409, 'SHOW_STALE');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='show.updated'", [scheduled.id])).rows[0].n, 1);
    });
    await scenario('two API instances editing one show revision produce one success and one conflict', async () => {
      const responses = await Promise.all([patch(scheduled.id, { expectedRevision: 1, priceMinor: 81000 }), patch(scheduled.id, { expectedRevision: 1, priceMinor: 82000 }, other)]);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); const saved = await read(scheduled.id); assert.equal(saved.revision, 2); assert.ok([81000, 82000].includes(saved.priceMinor));
    });
    await scenario('audit failures roll back creation, patch and deletion with revisions', async () => {
      await pool.query(`CREATE FUNCTION fail_show_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='show' THEN RAISE EXCEPTION 'injected show audit failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER fail_show_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_show_audit_test()');
      const before = await read(scheduled.id), count = (await pool.query('SELECT count(*)::int AS n FROM shows')).rows[0].n;
      try { await expect(await create(), 500, 'INTERNAL_ERROR'); await expect(await patch(scheduled.id, { expectedRevision: 2, priceMinor: 1 }), 500); await expect(await remove(scheduled.id, 2), 500); assert.deepEqual(await read(scheduled.id), before); assert.equal((await pool.query('SELECT count(*)::int AS n FROM shows')).rows[0].n, count); }
      finally { await pool.query('DROP TRIGGER fail_show_audit_test ON audit_events'); await pool.query('DROP FUNCTION fail_show_audit_test()'); }
    });
    await scenario('price-only edits preserve PostgreSQL microseconds instead of writing a JavaScript Date back', async () => {
      const show = await (await expect(await create(), 201)).json();
      await pool.query("UPDATE shows SET starts_at='2035-10-30T18:00:00.123456Z' WHERE id=$1", [show.id]);
      await expect(await patch(show.id, { expectedRevision: 0, priceMinor: 12 }), 200);
      assert.equal((await pool.query("SELECT to_char(starts_at AT TIME ZONE 'UTC','US') AS micros FROM shows WHERE id=$1", [show.id])).rows[0].micros, '123456');
    });
    await scenario('unpriced imported draft shows require an explicit price instead of guessing from inventory', async () => {
      const imported = (await pool.query('INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,$4) RETURNING id', [event.id, venue.id, org.id, future()])).rows[0];
      const before = await read(imported.id); assert.equal(before.priceMinor, null); assert.equal(before.currency, null);
      await expect(await patch(imported.id, { expectedRevision: 0, startsAt: future() }), 409, 'SHOW_PRICE_REQUIRED');
      const fixed = await (await expect(await patch(imported.id, { expectedRevision: 0, priceMinor: 0 }), 200)).json(); assert.equal(fixed.revision, 1); assert.equal(fixed.priceMinor, 0); assert.equal(fixed.currency, 'INR');
      await remove(imported.id, 1);
    });
    await scenario('event publication committed while a scheduling request waits is rechecked', async () => {
      const targetEvent = await newEvent(), db = await pool.connect(); let pending;
      try {
        await db.query('BEGIN'); await db.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [targetEvent.id]);
        pending = request(owner, root(targetEvent.id), { method: 'POST', body: input(), target: other });
        const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; await waitForBlock(pid);
        await db.query("UPDATE events SET status='PUBLISHED' WHERE id=$1", [targetEvent.id]); await db.query('COMMIT'); await expect(await pending, 409, 'EVENT_NOT_EDITABLE');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM shows WHERE event_id=$1', [targetEvent.id])).rows[0].n, 0);
      } finally { await db.query('ROLLBACK'); db.release(); if (pending) await pending.catch(() => {}); }
    });
    await scenario('time validity is evaluated after a real venue lock wait with database wall time', async () => {
      const target = await newVenue(); let pending;
      await withBlockedVenue(target.id, async (db, pid) => {
        const startsAt = (await db.query("SELECT clock_timestamp()+interval '500 milliseconds' AS at")).rows[0].at.toISOString();
        pending = create({ ...input(), venueId: target.id, startsAt }, other); await waitForBlock(pid);
        while ((await db.query('SELECT clock_timestamp()<$1::timestamptz AS waiting', [startsAt])).rows[0].waiting) await pause(10);
        await db.query('COMMIT'); await expect(await pending, 409, 'SHOW_TIME_PASSED');
      });
    });
    await scenario('layout revision is rechecked after waiting and a timeout rolls back cleanly', async () => {
      const target = await newVenue();
      await withBlockedVenue(target.id, async (db, pid) => {
        const pending = create({ ...input(), venueId: target.id }, other); await waitForBlock(pid);
        await db.query('UPDATE venues SET revision=revision+1 WHERE id=$1', [target.id]); await db.query('COMMIT'); await expect(await pending, 409, 'VENUE_STALE');
      });
      await withBlockedVenue(target.id, async (db, pid) => {
        const pending = create({ ...input(), venueId: target.id, expectedVenueRevision: 1 }, other); await waitForBlock(pid); await expect(await pending, 503, 'ACCESS_BUSY');
      });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM shows WHERE venue_id=$1', [target.id])).rows[0].n, 0);
    });
    await scenario('inventory or a non-draft event freezes scheduling edits and removal', async () => {
      const target = await (await expect(await create(), 201)).json();
      await pool.query('INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) SELECT $1,id,venue_id,75000 FROM venue_seats WHERE venue_id=$2', [target.id, venue.id]);
      assert.equal((await read(target.id)).inUse, true);
      await expect(await patch(target.id, { expectedRevision: 0, priceMinor: 1 }), 409, 'SHOW_IN_USE'); await expect(await remove(target.id, 0), 409, 'SHOW_IN_USE');
      await pool.query("UPDATE events SET status='PUBLISHED' WHERE id=$1", [event.id]);
      try { await expect(await create(), 409, 'EVENT_NOT_EDITABLE'); await expect(await patch(scheduled.id, { expectedRevision: 2, priceMinor: 1 }), 409, 'EVENT_NOT_EDITABLE'); await expect(await remove(scheduled.id, 2), 409, 'EVENT_NOT_EDITABLE'); await expect(await request(staff, root()), 200); }
      finally { await pool.query("UPDATE events SET status='DRAFT' WHERE id=$1", [event.id]); }
      await pool.query("UPDATE shows SET status='CANCELLED' WHERE id=$1", [target.id]); await expect(await remove(target.id, 0), 409, 'SHOW_NOT_EDITABLE');
    });
    await scenario('a committed inventory insert is observed after a real foreign-key lock wait', async () => {
      const target = await (await expect(await create(), 201)).json(), db = await pool.connect(); let pending;
      try {
        await db.query('BEGIN'); await db.query('INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) SELECT $1,id,venue_id,75000 FROM venue_seats WHERE venue_id=$2', [target.id, venue.id]);
        const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = patch(target.id, { expectedRevision: 0, priceMinor: 2 }, other); await waitForBlock(pid); await db.query('COMMIT'); await expect(await pending, 409, 'SHOW_IN_USE');
      } finally { await db.query('ROLLBACK'); db.release(); if (pending) await pending.catch(() => {}); }
    });
    await scenario('concurrent real layout replacement and scheduling cannot use an unreviewed plan', async () => {
      const target = await newVenue();
      const responses = await Promise.all([create({ ...input(), venueId: target.id }), request(owner, `/organizers/${org.id}/venues/${target.id}/layout`, { method: 'PUT', target: other, body: { expectedRevision: 0, sections: [{ name: 'Replacement', rows: [{ label: 'B', seats: 2 }] }] } })]);
      const statuses = responses.map(r => r.status);
      assert.ok((statuses[0] === 201 && statuses[1] === 409) || (statuses[0] === 409 && statuses[1] === 200), JSON.stringify(statuses));
      const shows = (await pool.query('SELECT count(*)::int AS n FROM shows WHERE venue_id=$1', [target.id])).rows[0].n;
      const saved = (await pool.query('SELECT revision FROM venues WHERE id=$1', [target.id])).rows[0];
      assert.equal(shows, statuses[0] === 201 ? 1 : 0); assert.equal(saved.revision, statuses[1] === 200 ? 1 : 0);
      if (statuses[0] === 409) await expect(responses[0], 409, 'VENUE_STALE'); else await expect(responses[1], 409, 'VENUE_IN_USE');
    });
    await scenario('unused removal is audited, refuses stale input and releases the last venue reference', async () => {
      const targetVenue = await newVenue(), target = await (await expect(await create({ ...input(), venueId: targetVenue.id }), 201)).json();
      await expect(await remove(target.id, 1), 409, 'SHOW_STALE');
      assert.deepEqual(await (await expect(await remove(target.id, 0), 200)).json(), { id: target.id, deleted: true }); await expect(await request(owner, url(target.id)), 404);
      const detail = await (await expect(await request(owner, `/organizers/${org.id}/venues/${targetVenue.id}`), 200)).json(); assert.equal(detail.hasShows, false);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='show.deleted'", [target.id])).rows[0].n, 1);
    });
    await scenario('suspension, revocation, Origin and CSRF boundaries remain authoritative', async () => {
      await expect(await request(owner, root(), { method: 'POST', body: input(), headers: { Origin: 'https://attacker.invalid' } }), 403);
      await expect(await request(owner, root(), { method: 'POST', body: input(), headers: { 'X-CSRF-Token': '' } }), 403);
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id]); await expect(await create(), 403, 'ORGANIZER_NOT_APPROVED'); await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [org.id]);
      await pool.query('UPDATE organizer_memberships SET revoked_at=clock_timestamp() WHERE organizer_id=$1 AND user_id=$2', [org.id, staff.id]); await expect(await request(staff, root()), 404);
    });
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); }
    await adminPool.end();
  }
});
