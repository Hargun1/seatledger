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

test('owned venue metadata/layout transactions and show races (real PostgreSQL + two APIs)', { timeout: 60000 }, async t => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original), servers = [];
  let admin, pool, schema, base, other, owner, staff, outsider, reviewer, org, venue;
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: 'https://seatledger.test' };
  const small = count => [{ name: 'Main', rows: [{ label: 'A', seats: count }] }];
  const path = (id = venue?.id, organizationId = org?.id) => `/organizers/${organizationId}/venues${id ? `/${id}` : ''}`;
  async function request(actor, url, { method = 'GET', body, target = base, headers = {} } = {}) {
    return fetch(target + '/api' + url, { method,
      headers: { Cookie: actor.cookie, ...(method !== 'GET' ? { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': actor.csrf } : {}), ...headers },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
  }
  async function expect(response, status) { assert.equal(response.status, status, await response.clone().text()); return response; }
  async function actor(role = 'CUSTOMER') {
    const user = (await pool.query("INSERT INTO users(email,display_name,password_hash,system_role) VALUES($1,'Venue fixture','fixture-only-not-for-login',$2) RETURNING id", [`${randomUUID()}@example.invalid`, role])).rows[0];
    const raw = newToken(), csrf = csrfFor(raw, config.AUTH_SECRET);
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrf)]);
    return { id: user.id, cookie: `seatledger_session=${raw}`, csrf };
  }
  async function createOrganization(actor, status = 'APPROVED') {
    const row = (await pool.query(`INSERT INTO organizers(name,status,approved_by,approved_at)
      VALUES('Venue team',$1,$2,$3) RETURNING id`, [status, status === 'APPROVED' ? reviewer.id : null, status === 'APPROVED' ? new Date() : null])).rows[0];
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER')", [row.id, actor.id]); return row;
  }
  async function createVenue(name = 'Small Stage') {
    return (await expect(await request(owner, path(null), { method: 'POST', body: { name, city: 'Bengaluru' } }), 201)).json();
  }
  async function read(id = venue.id) { return (await expect(await request(owner, path(id)), 200)).json(); }
  async function replace(id, expectedRevision, count, target = base) {
    return request(owner, path(id) + '/layout', { method: 'PUT', target, body: { expectedRevision, sections: small(count) } });
  }
  async function show(db, venueId) {
    const event = (await db.query("INSERT INTO events(title,category,organizer_id) VALUES('Private show fixture','Talks',$1) RETURNING id", [org.id])).rows[0];
    return (await db.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day') RETURNING id", [event.id, venueId, org.id])).rows[0];
  }
  async function scenario(name, work) {
    let failure;
    await t.test(name, async () => { try { await work(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
  }
  async function waitForBlock(controlPid) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [controlPid])).rows[0].waiting) return;
      await pause(10);
    }
    assert.fail('Expected an actual database lock wait');
  }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT');
    const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(url.toString());
    for (let i = 0; i < 2; i++) {
      const server = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1'); servers.push(server);
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    }
    [base, other] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
    reviewer = await actor('ADMIN'); owner = await actor(); staff = await actor(); outsider = await actor(); org = await createOrganization(owner);
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'STAFF')", [org.id, staff.id]);
    await scenario('approved owner creates a revision-zero venue and an audited empty layout', async () => {
      venue = await createVenue("Stage'); DROP TABLE venues; --");
      assert.equal(venue.revision, 0); assert.equal(venue.timezone, 'Asia/Kolkata'); assert.equal(venue.name, "Stage'); DROP TABLE venues; --");
      const detail = await read(); assert.deepEqual(detail.sections, []); assert.equal(detail.hasShows, false);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_type='venue' AND entity_id=$1 AND action='venue.created'", [venue.id])).rows[0].n, 1);
    });
    await scenario('strict input rejects role/ownership/revision/timezone injection and unsafe paths', async () => {
      for (const body of [{ name: 'No', city: 'City', organizer_id: org.id }, { name: 'No', city: 'City', revision: 5 }, { name: 'No', city: 'City', timezone: 'No/SuchZone' }]) await expect(await request(owner, path(null), { method: 'POST', body }), 400);
      await expect(await request(owner, path(), { method: 'PATCH', body: { city: 'City' } }), 400);
      await expect(await request(owner, path('not-a-uuid')), 404);
      await expect(await request(owner, path(null) + '?limit=51'), 400);
    });
    await scenario('foreign tenants and administrators without membership cannot use venue IDs', async () => {
      for (const actor of [outsider, reviewer]) {
        await expect(await request(actor, path()), 404);
        await expect(await request(actor, path(), { method: 'PATCH', body: { expectedRevision: 0, city: 'Stolen' } }), 404);
      }
      const foreign = await createOrganization(outsider);
      await expect(await request(outsider, path(venue.id, foreign.id)), 404);
      assert.equal((await read()).city, 'Bengaluru');
    });
    await scenario('staff read scoped metadata but cannot create, patch, replace or delete', async () => {
      const listing = await (await expect(await request(staff, path(null)), 200)).json(); assert.equal(listing.organization.role, 'STAFF');
      await expect(await request(staff, path()), 200);
      for (const [url, method, body] of [[path(null), 'POST', { name: 'No', city: 'City' }], [path(), 'PATCH', { expectedRevision: 0, city: 'No' }], [path() + '/layout', 'PUT', { expectedRevision: 0, sections: small(2) }], [path(), 'DELETE', { expectedRevision: 0 }]]) await expect(await request(staff, url, { method, body }), 403);
    });
    await scenario('layout replacement expands exact rows/seats with fresh server IDs in one audited commit', async () => {
      const response = await expect(await request(owner, path() + '/layout', { method: 'PUT', body: { expectedRevision: 0, sections: [{ name: 'Main', rows: [{ label: 'A', seats: 3 }, { label: 'B', seats: 2 }] }, { name: 'Balcony', rows: [{ label: 'AA', seats: 2 }] }] } }), 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); assert.equal(body.revision, 1); assert.equal(body.sections.length, 2); assert.equal(body.sections.flatMap(section => section.seats).length, 7);
      const main = body.sections.find(section => section.name === 'Main');
      assert.deepEqual(main.seats.map(seat => [seat.rowLabel, seat.number]), [['A', 1], ['A', 2], ['A', 3], ['B', 1], ['B', 2]]);
      for (const seat of body.sections.flatMap(section => section.seats)) assert.match(seat.id, /^[a-f0-9-]{36}$/);
      assert.equal((await read()).revision, 1);
    });
    await scenario('invalid layouts and stale revisions leave all existing seat IDs unchanged', async () => {
      const before = await read();
      await expect(await replace(venue.id, 0, 4), 409);
      await expect(await request(owner, path() + '/layout', { method: 'PUT', body: { expectedRevision: 1, sections: [{ name: 'Main', rows: [{ label: 'A', seats: 2 }, { label: ' A ', seats: 2 }] }] } }), 400);
      assert.deepEqual(await read(), before);
    });
    await scenario('metadata patches share the layout revision and unchanged metadata is a no-op', async () => {
      const updated = await (await expect(await request(owner, path(), { method: 'PATCH', body: { expectedRevision: 1, city: 'Mysuru', timezone: 'UTC' } }), 200)).json();
      assert.equal(updated.revision, 2); assert.equal(updated.name, venue.name);
      const unchanged = await (await expect(await request(owner, path(), { method: 'PATCH', body: { expectedRevision: 2, city: 'Mysuru' } }), 200)).json(); assert.equal(unchanged.revision, 2);
      await expect(await replace(venue.id, 1, 3), 409); assert.equal((await read()).sections.flatMap(section => section.seats).length, 7);
    });
    await scenario('audit failure rolls back seat replacement, fresh IDs and revision together', async () => {
      const before = await read();
      await pool.query(`CREATE FUNCTION fail_layout_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='venue.layout_replaced' THEN RAISE EXCEPTION 'injected layout audit failure'; END IF; RETURN NEW; END; $$`);
      await pool.query('CREATE TRIGGER fail_layout_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_layout_audit_test()');
      try { const response = await expect(await replace(venue.id, 2, 4), 500); assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' }); assert.deepEqual(await read(), before); }
      finally { await pool.query('DROP TRIGGER fail_layout_audit_test ON audit_events'); await pool.query('DROP FUNCTION fail_layout_audit_test()'); }
    });
    await scenario('two API owners replacing one revision produce one complete layout and one conflict', async () => {
      const target = await createVenue('Concurrent layout');
      const responses = await Promise.all([replace(target.id, 0, 3), replace(target.id, 0, 4, other)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      const detail = await read(target.id); assert.equal(detail.revision, 1); assert.equal(detail.sections.length, 1);
      assert.ok([3, 4].includes(detail.sections[0].seats.length));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='venue.layout_replaced'", [target.id])).rows[0].n, 1);
    });
    await scenario('500-seat layouts succeed and oversized trusted-SQL catalogs are not returned partially', async () => {
      const target = await createVenue('Bounded layout');
      const rows = Array.from({ length: 13 }, (_, i) => ({ label: String(i), seats: i === 12 ? 20 : 40 }));
      await expect(await request(owner, path(target.id) + '/layout', { method: 'PUT', body: { expectedRevision: 0, sections: [{ name: 'Main', rows }] } }), 200);
      const detail = await read(target.id); assert.equal(detail.sections[0].seats.length, 500);
      await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) VALUES($1,$2,'extra',1)", [target.id, detail.sections[0].id]);
      const response = await expect(await request(owner, path(target.id)), 409); assert.deepEqual(await response.json(), { error: 'LAYOUT_TOO_LARGE' });
    });
    await scenario('all writes freeze at the first show, even without inventory or reservations', async () => {
      await show(pool, venue.id); const before = await read(); assert.equal(before.hasShows, true);
      await expect(await request(owner, path(), { method: 'PATCH', body: { expectedRevision: 2, name: 'No edit' } }), 409);
      await expect(await replace(venue.id, 2, 4), 409);
      await expect(await request(owner, path(), { method: 'DELETE', body: { expectedRevision: 2 } }), 409);
      await pool.query("UPDATE shows SET status='CANCELLED' WHERE venue_id=$1", [venue.id]);
      await expect(await replace(venue.id, 2, 4), 409); assert.deepEqual(await read(), before);
    });
    await scenario('a show committed while a layout request waits is seen after the venue lock', async () => {
      const target = await createVenue('Show race'); await expect(await replace(target.id, 0, 2), 200);
      const before = await read(target.id), control = await pool.connect(); let pending;
      try {
        await control.query('BEGIN'); await show(control, target.id); // FK holds a key-share lock on the venue.
        const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = replace(target.id, 1, 4, other); await waitForBlock(pid);
        await control.query('COMMIT');
        const response = await expect(await pending, 409); assert.deepEqual(await response.json(), { error: 'VENUE_IN_USE' });
        const after = await read(target.id); assert.equal(after.revision, before.revision); assert.deepEqual(after.sections, before.sections);
      } finally { await control.query('ROLLBACK'); control.release(); if (pending) await pending.catch(() => {}); }
    });
    await scenario('deleting an unused venue removes its children but preserves the committed audit', async () => {
      const target = await createVenue('Delete unused'); await expect(await replace(target.id, 0, 3), 200);
      await expect(await request(owner, path(target.id), { method: 'DELETE', body: { expectedRevision: 0 } }), 409);
      const before = await read(target.id);
      await pool.query(`CREATE FUNCTION fail_delete_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='venue.deleted' THEN RAISE EXCEPTION 'injected delete audit failure'; END IF; RETURN NEW; END; $$`);
      await pool.query('CREATE TRIGGER fail_delete_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_delete_audit_test()');
      try { await expect(await request(owner, path(target.id), { method: 'DELETE', body: { expectedRevision: 1 } }), 500); assert.deepEqual(await read(target.id), before); }
      finally { await pool.query('DROP TRIGGER fail_delete_audit_test ON audit_events'); await pool.query('DROP FUNCTION fail_delete_audit_test()'); }
      const result = await (await expect(await request(owner, path(target.id), { method: 'DELETE', body: { expectedRevision: 1 } }), 200)).json(); assert.deepEqual(result, { id: target.id, deleted: true });
      await expect(await request(owner, path(target.id)), 404);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_seats WHERE venue_id=$1', [target.id])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='venue.deleted'", [target.id])).rows[0].n, 1);
    });
    await scenario('lists are bounded and pending/suspended/revoked memberships lose venue access', async () => {
      const response = await expect(await request(owner, path(null) + '?limit=1'), 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const first = await response.json(); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
      const second = await (await expect(await request(owner, path(null) + '?limit=1&after=' + first.nextCursor), 200)).json(); assert.notEqual(first.items[0].id, second.items[0].id);
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id]); await expect(await request(owner, path(null)), 403);
      await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [org.id]);
      await pool.query('UPDATE organizer_memberships SET revoked_at=clock_timestamp() WHERE organizer_id=$1 AND user_id=$2', [org.id, staff.id]); await expect(await request(staff, path()), 404);
      const applicant = await actor(), pendingOrg = await createOrganization(applicant, 'PENDING');
      await expect(await request(applicant, `/organizers/${pendingOrg.id}/venues`), 403);
    });
    await scenario('Origin, CSRF and request-size boundaries apply to all venue mutations', async () => {
      await expect(await request(owner, path(null), { method: 'POST', body: { name: 'No', city: 'City' }, headers: { Origin: 'https://attacker.invalid' } }), 403);
      await expect(await request(owner, path(null), { method: 'POST', body: { name: 'No', city: 'City' }, headers: { 'X-CSRF-Token': '' } }), 403);
      await expect(await request(owner, path(null), { method: 'POST', body: { name: 'X'.repeat(18000), city: 'City' } }), 413);
    });
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); }
    await adminPool.end();
  }
});
