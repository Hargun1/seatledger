import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { grantDevelopmentAdmin } from '../../scripts/lib/dev-admin.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('organizer approval, scoped draft APIs and authorization races (real PostgreSQL + HTTP)', { timeout: 60000 }, async t => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original);
  let admin, pool, schema; const servers = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: 'https://seatledger.test' };
  async function start() {
    const server = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function user(role = 'CUSTOMER') {
    const row = (await pool.query(`INSERT INTO users (email,display_name,password_hash,system_role)
      VALUES ($1,'Access fixture','fixture hash not used for password login',$2) RETURNING id,email`, [`${randomUUID()}@example.invalid`, role])).rows[0];
    const raw = newToken(), csrf = csrfFor(raw, config.AUTH_SECRET);
    const session = (await pool.query(`INSERT INTO sessions (user_id,token_hash,csrf_token_hash,expires_at)
      VALUES ($1,$2,$3,clock_timestamp()+interval '1 day') RETURNING id`, [row.id, digest(raw), digest(csrf)])).rows[0];
    return { ...row, sessionId: session.id, cookie: `seatledger_session=${raw}`, csrf };
  }
  async function request(base, actor, path, { method = 'GET', body, headers = {} } = {}) {
    const mutation = method !== 'GET';
    return fetch(base + '/api' + path, { method,
      headers: { Cookie: actor.cookie, ...(mutation ? { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': actor.csrf } : {}), ...headers },
      ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}) });
  }
  async function scenario(name, work) {
    let failure;
    await t.test(name, async () => {
      try { await work(); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  async function expectStatus(response, status) { assert.equal(response.status, status, await response.clone().text()); return response; }
  async function organization(base, actor, name = 'Small stage') {
    return (await expectStatus(await request(base, actor, '/organizers', { method: 'POST', body: { name } }), 201)).json();
  }
  const path = org => `/organizers/${org.id}/events`;
  async function decision(base, actor, org, status) {
    const { status_version: expectedVersion } = (await pool.query('SELECT status_version FROM organizers WHERE id=$1', [org.id])).rows[0];
    return request(base, actor, `/admin/organizers/${org.id}/status`, { method: 'POST', body: { status, expectedVersion } });
  }
  async function behindLock(sql, values, operation, change) {
    const control = await pool.connect(); let pending;
    try {
      await control.query('BEGIN'); await control.query(sql, values);
      const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = operation();
      const deadline = Date.now() + 1000; let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await admin.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting;
        if (waiting) break;
        await pause(10);
      }
      assert.equal(waiting, true, 'The HTTP transaction must actually wait on the controlled row lock.');
      await change(control); await control.query('COMMIT');
      return await pending;
    } finally { await control.query('ROLLBACK'); control.release(); if (pending) await pending.catch(() => {}); }
  }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN');
    schema = await installReliabilitySchema(admin, 'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/006_auth_throttling.sql', import.meta.url), 'utf8'));
    await admin.query(await readFile(new URL('../../db/migrations/007_organizer_review_versions.sql', import.meta.url), 'utf8'));
    for (const name of ['008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT');
    const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = createPool(url.toString());
    const base = await start(), otherBase = await start();
    const owner = await user(), outsider = await user(), reviewer = await user('ADMIN');
    let org, event;

    await scenario('customers cannot review approvals and registration cannot inject organization state', async () => {
      await expectStatus(await request(base, owner, '/admin/organizers'), 403);
      await expectStatus(await request(base, owner, '/organizers', { method: 'POST', body: { name: 'Stage', status: 'APPROVED' } }), 400);
      assert.deepEqual(await (await request(base, owner, '/organizers')).json(), { items: [], nextCursor: null });
    });
    await scenario('request commits a pending organization, its owner membership and one audit', async () => {
      org = await organization(base, owner, "Reader's stage");
      assert.equal(org.status, 'PENDING'); assert.equal(org.approvedAt, null);
      const membership = (await pool.query('SELECT role FROM organizer_memberships WHERE organizer_id=$1 AND user_id=$2', [org.id, owner.id])).rows[0];
      assert.equal(membership.role, 'OWNER');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='organizer.requested'", [org.id])).rows[0].n, 1);
      await expectStatus(await request(base, owner, path(org)), 403);
      await expectStatus(await request(base, owner, path(org), { method: 'POST', body: { title: 'Talk', category: 'Talks' } }), 403);
    });
    await scenario('two API instances serialize concurrent pending applications from one user', async () => {
      const applicant = await user();
      const responses = await Promise.all([base, otherBase].map(target => request(target, applicant, '/organizers', { method: 'POST', body: { name: 'One pending application' } })));
      assert.deepEqual(responses.map(value => value.status).sort(), [201, 409]);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM organizers o JOIN organizer_memberships m ON m.organizer_id=o.id
        WHERE m.user_id=$1 AND o.status='PENDING'`, [applicant.id])).rows[0].n, 1);
    });
    await scenario('admin approval is audited once and repeated same-state decisions are no-ops', async () => {
      const approved = await (await expectStatus(await decision(base, reviewer, org, 'APPROVED'), 200)).json();
      const repeated = await (await expectStatus(await decision(otherBase, reviewer, org, 'APPROVED'), 200)).json();
      assert.equal(approved.approvedAt, repeated.approvedAt);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='organizer.approved'", [org.id])).rows[0].n, 1);
      await expectStatus(await decision(base, owner, org, 'SUSPENDED'), 403);
    });
    await scenario('review decisions require versions and an old command cannot undo an approval round trip', async () => {
      const reviewPath = `/admin/organizers/${org.id}/status`;
      const current = (await pool.query('SELECT status_version FROM organizers WHERE id=$1', [org.id])).rows[0].status_version;
      for (const body of [{ status: 'SUSPENDED' }, { status: 'SUSPENDED', expectedVersion: -1 }]) {
        await expectStatus(await request(base, reviewer, reviewPath, { method: 'POST', body }), 400);
      }
      const suspended = await (await expectStatus(await decision(base, reviewer, org, 'SUSPENDED'), 200)).json();
      assert.equal(suspended.statusVersion, current + 1);
      const before = (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1', [org.id])).rows[0].n;
      const stale = await expectStatus(await request(otherBase, reviewer, reviewPath, { method: 'POST', body: { status: 'APPROVED', expectedVersion: current } }), 409);
      assert.deepEqual(await stale.json(), { error: 'REVIEW_STALE' });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1', [org.id])).rows[0].n, before);
      const restored = await (await expectStatus(await decision(base, reviewer, org, 'APPROVED'), 200)).json();
      assert.equal(restored.statusVersion, current + 2);
      await expectStatus(await request(base, reviewer, reviewPath, { method: 'POST', body: { status: 'SUSPENDED', expectedVersion: current } }), 409);
      const list = await (await expectStatus(await request(base, reviewer, '/admin/organizers?status=APPROVED'), 200)).json();
      assert.equal(list.items.find(row => row.id === org.id).statusVersion, restored.statusVersion);
    });
    await scenario('two API reviewers using one version produce one change and one conflict', async () => {
      const pending = await organization(base, await user());
      const body = { status: 'APPROVED', expectedVersion: 0 }, reviewPath = `/admin/organizers/${pending.id}/status`;
      const responses = await Promise.all([base, otherBase].map(target => request(target, reviewer, reviewPath, { method: 'POST', body })));
      assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
      assert.equal((await pool.query('SELECT status_version FROM organizers WHERE id=$1', [pending.id])).rows[0].status_version, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='organizer.approved'", [pending.id])).rows[0].n, 1);
    });
    await scenario('status versions are database-managed, direct status changes advance them and renames do not', async () => {
      const before = (await pool.query('SELECT status_version FROM organizers WHERE id=$1', [org.id])).rows[0].status_version;
      await pool.query('UPDATE organizers SET name=name WHERE id=$1', [org.id]);
      assert.equal((await pool.query('SELECT status_version FROM organizers WHERE id=$1', [org.id])).rows[0].status_version, before);
      await assert.rejects(pool.query('UPDATE organizers SET status_version=0 WHERE id=$1', [org.id]), { code: '23514' });
      await assert.rejects(pool.query("INSERT INTO organizers(name,status_version) VALUES('Invalid initial version',2)"), { code: '23514' });
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id]);
      assert.equal((await pool.query('SELECT status_version FROM organizers WHERE id=$1', [org.id])).rows[0].status_version, before + 1);
      await expectStatus(await decision(base, reviewer, org, 'APPROVED'), 200);
    });
    await scenario('audit failure rolls back an admin decision and its status version together', async () => {
      const before = (await pool.query('SELECT status,status_version FROM organizers WHERE id=$1', [org.id])).rows[0];
      await pool.query(`CREATE FUNCTION fail_review_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='organizer.suspended' THEN RAISE EXCEPTION 'injected review failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER fail_review_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_review_audit_test()');
      try {
        await expectStatus(await decision(base, reviewer, org, 'SUSPENDED'), 500);
        assert.deepEqual((await pool.query('SELECT status,status_version FROM organizers WHERE id=$1', [org.id])).rows[0], before);
      } finally { await pool.query('DROP TRIGGER fail_review_audit_test ON audit_events'); await pool.query('DROP FUNCTION fail_review_audit_test()'); }
    });
    await scenario('only an approved owner can create a DRAFT and SQL-looking input stays data', async () => {
      event = await (await expectStatus(await request(base, owner, path(org), { method: 'POST', body: { title: "Talk'); DROP TABLE events; --", category: 'Talks' } }), 201)).json();
      assert.equal(event.status, 'DRAFT'); assert.equal(event.title, "Talk'); DROP TABLE events; --");
      assert.deepEqual(Object.keys(event).sort(), ['category', 'createdAt', 'id', 'status', 'title']);
      await expectStatus(await request(base, owner, path(org), { method: 'POST', body: { title: 'Injected', category: 'Talks', organizer_id: randomUUID() } }), 400);
      await expectStatus(await request(base, owner, path(org), { method: 'POST', body: { title: 'Injected', category: 'Talks', status: 'PUBLISHED' } }), 400);
    });
    await scenario('foreign organization/resource IDs stay hidden and system admins do not bypass membership', async () => {
      const foreign = await organization(base, outsider, 'Another stage');
      await expectStatus(await decision(base, reviewer, foreign, 'APPROVED'), 200);
      for (const actor of [outsider, reviewer]) {
        await expectStatus(await request(base, actor, path(org)), 404);
        await expectStatus(await request(base, actor, `${path(org)}/${event.id}`, { method: 'PATCH', body: { title: 'Stolen' } }), 404);
      }
      await expectStatus(await request(base, owner, `${path(foreign)}/${event.id}`), 404);
      await expectStatus(await request(base, outsider, `${path(foreign)}/${event.id}`, { method: 'PATCH', body: { title: 'Stolen' } }), 404);
      assert.notEqual((await pool.query('SELECT title FROM events WHERE id=$1', [event.id])).rows[0].title, 'Stolen');
    });
    await scenario('staff can read but cannot mutate; revoked membership cannot read', async () => {
      const staff = await user();
      await pool.query("INSERT INTO organizer_memberships (organizer_id,user_id,role) VALUES ($1,$2,'STAFF')", [org.id, staff.id]);
      await expectStatus(await request(base, staff, `${path(org)}/${event.id}`), 200);
      const staffPage = await (await expectStatus(await request(base, staff, path(org)), 200)).json();
      assert.deepEqual(staffPage.organization, { id: org.id, name: org.name, status: 'APPROVED', role: 'STAFF' });
      await expectStatus(await request(base, staff, path(org), { method: 'POST', body: { title: 'No', category: 'Talks' } }), 403);
      await pool.query('UPDATE organizer_memberships SET revoked_at=clock_timestamp() WHERE organizer_id=$1 AND user_id=$2', [org.id, staff.id]);
      await expectStatus(await request(base, staff, path(org)), 404);
    });
    await scenario('draft patches preserve unspecified fields across concurrent API instances', async () => {
      const responses = await Promise.all([
        request(base, owner, `${path(org)}/${event.id}`, { method: 'PATCH', body: { title: 'New title' } }),
        request(otherBase, owner, `${path(org)}/${event.id}`, { method: 'PATCH', body: { category: 'Music' } })
      ]);
      assert.deepEqual(responses.map(value => value.status), [200, 200]);
      const stored = (await pool.query('SELECT title,category FROM events WHERE id=$1', [event.id])).rows[0];
      assert.deepEqual(stored, { title: 'New title', category: 'Music' });
      for (const status of ['PUBLISHED', 'CANCELLED']) {
        await pool.query('UPDATE events SET status=$2 WHERE id=$1', [event.id, status]);
        await expectStatus(await request(base, owner, `${path(org)}/${event.id}`, { method: 'PATCH', body: { title: 'Blocked' } }), 409);
      }
      await pool.query("UPDATE events SET status='DRAFT' WHERE id=$1", [event.id]);
    });
    await scenario('suspension blocks approved members and reapproval restores access', async () => {
      await expectStatus(await decision(base, reviewer, org, 'SUSPENDED'), 200);
      await expectStatus(await request(base, owner, path(org)), 403);
      await expectStatus(await request(base, owner, `${path(org)}/${event.id}`, { method: 'PATCH', body: { title: 'Blocked' } }), 403);
      await expectStatus(await decision(base, reviewer, org, 'APPROVED'), 200);
      await expectStatus(await request(base, owner, path(org)), 200);
      const pending = await organization(base, await user());
      await expectStatus(await decision(base, reviewer, pending, 'SUSPENDED'), 409);
    });
    await scenario('no CSRF/origin bypass, UUID casts or unbounded query options', async () => {
      await expectStatus(await request(base, owner, path(org), { method: 'POST', body: { title: 'No', category: 'Talks' }, headers: { 'X-CSRF-Token': '' } }), 403);
      await expectStatus(await request(base, owner, path(org), { method: 'POST', body: {}, headers: { Origin: 'https://attacker.invalid' } }), 403);
      await expectStatus(await request(base, owner, '/organizers/not-a-uuid/events'), 404);
      await expectStatus(await request(base, owner, path(org) + '?limit=51'), 400);
      await expectStatus(await request(base, reviewer, '/admin/organizers?status=UNKNOWN'), 400);
      await expectStatus(await request(base, owner, path(org), { method: 'POST', body: { title: 'Second event', category: 'Talks' } }), 201);
      const response = await expectStatus(await request(base, owner, path(org) + '?limit=1'), 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const first = await response.json(); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
      const second = await (await request(base, owner, path(org) + '?limit=1&after=' + first.nextCursor)).json();
      assert.equal(second.items.length, 1); assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
    });
    await scenario('development bootstrap is explicit, audited, idempotent and visible to existing sessions', async () => {
      const candidate = await user();
      await expectStatus(await request(base, candidate, '/admin/organizers'), 403);
      const env = { NODE_ENV: 'test', ALLOW_DEV_ADMIN: 'true' };
      assert.deepEqual(await grantDevelopmentAdmin(pool, env, candidate.email), { changed: true });
      assert.deepEqual(await grantDevelopmentAdmin(pool, env, candidate.email), { changed: false });
      await expectStatus(await request(base, candidate, '/admin/organizers'), 200);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='dev.admin_granted' AND entity_id=$1", [candidate.id])).rows[0].n, 1);
      const disabled = await user(); await pool.query("UPDATE users SET status='DISABLED' WHERE id=$1", [disabled.id]);
      await assert.rejects(grantDevelopmentAdmin(pool, env, disabled.email), { code: 'ACCOUNT_NOT_ELIGIBLE' });
    });
    await scenario('an audit insert failure rolls back event creation rather than reporting partial success', async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n;
      await pool.query(`CREATE FUNCTION fail_event_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='event.created' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER fail_event_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_event_audit_test()');
      try {
        const response = await expectStatus(await request(base, owner, path(org), { method: 'POST', body: { title: 'Must roll back', category: 'Talks' } }), 500);
        assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' });
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n, before);
      } finally { await pool.query('DROP TRIGGER fail_event_audit_test ON audit_events'); await pool.query('DROP FUNCTION fail_event_audit_test()'); }
    });
    await scenario('suspension committed while access waits is rechecked after the organization lock', async () => {
      const response = await behindLock('SELECT id FROM organizers WHERE id=$1 FOR UPDATE', [org.id],
        () => request(base, owner, path(org), { method: 'POST', body: { title: 'Must not appear', category: 'Talks' } }),
        db => db.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [org.id]));
      await expectStatus(response, 403);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE title=$1', ['Must not appear'])).rows[0].n, 0);
      await expectStatus(await decision(base, reviewer, org, 'APPROVED'), 200);
    });
    await scenario('revocation between initial session lookup and locked recheck prevents a write', async () => {
      const response = await behindLock('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.id],
        () => request(base, owner, path(org), { method: 'POST', body: { title: 'Revoked write', category: 'Talks' } }),
        db => db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [owner.sessionId]));
      await expectStatus(response, 401);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE title=$1', ['Revoked write'])).rows[0].n, 0);
    });
    await scenario('admin demotion while the request waits is honored without a new login', async () => {
      const response = await behindLock('SELECT id FROM users WHERE id=$1 FOR UPDATE', [reviewer.id],
        () => request(otherBase, reviewer, '/admin/organizers'),
        db => db.query("UPDATE users SET system_role='CUSTOMER' WHERE id=$1", [reviewer.id]));
      await expectStatus(response, 403);
    });
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    if (admin) {
      await admin.query('ROLLBACK');
      if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      admin.release();
    }
    await adminPool.end();
  }
});

