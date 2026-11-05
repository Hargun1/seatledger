import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.js';
import { pageInput, reviewInput, organizationInput, decisionInput, draftInput, draftPatch, parseInput, requireAdmin, requireMembership, validateDecision, pageResult } from '../apps/api/src/organizers/policy.js';
import { grantDevelopmentAdmin, requireDevelopmentAdmin } from '../scripts/lib/dev-admin.js';

test('organization and draft schemas reject privilege/ownership/state injection', () => {
  assert.deepEqual(parseInput(organizationInput, { name: '  Small Stage  ' }), { name: 'Small Stage' });
  for (const input of [{ name: 'Stage', status: 'APPROVED' }, { name: 'Stage', userId: 'someone' }, { name: '' }]) {
    assert.throws(() => parseInput(organizationInput, input), { status: 400 });
  }
  for (const input of [{ title: 'Talk', category: 'Talks', organizer_id: 'elsewhere' }, { title: 'Talk', category: 'Talks', status: 'PUBLISHED' }]) {
    assert.throws(() => parseInput(draftInput, input), { status: 400 });
  }
  assert.equal(draftPatch.safeParse({}).success, false);
  assert.equal(draftPatch.safeParse({ category: '  ' }).success, false);
  assert.deepEqual(parseInput(draftPatch, { title: ' New title ' }), { title: 'New title' });
});

test('admin status changes are explicit; repeated current decisions are no-ops', () => {
  assert.deepEqual(parseInput(decisionInput, { status: 'APPROVED', expectedVersion: 0 }), { status: 'APPROVED', expectedVersion: 0 });
  for (const input of [{ status: 'APPROVED' }, { status: 'APPROVED', expectedVersion: '0' }, { status: 'APPROVED', expectedVersion: -1 }, { status: 'APPROVED', expectedVersion: 0.5 }, { status: 'APPROVED', expectedVersion: 2147483648 }]) {
    assert.throws(() => parseInput(decisionInput, input), { status: 400 });
  }
  for (const [current, target] of [['PENDING', 'APPROVED'], ['APPROVED', 'SUSPENDED'], ['SUSPENDED', 'APPROVED']]) assert.equal(validateDecision(current, target), true);
  assert.equal(validateDecision('APPROVED', 'APPROVED'), false);
  assert.equal(validateDecision('SUSPENDED', 'SUSPENDED'), false);
  for (const [current, target] of [['PENDING', 'SUSPENDED'], ['APPROVED', 'PENDING'], ['UNKNOWN', 'UNKNOWN']]) assert.throws(() => validateDecision(current, target), { status: 409 });
  assert.throws(() => requireAdmin({ user: { role: 'CUSTOMER' } }), { status: 403 });
  requireAdmin({ user: { role: 'ADMIN' } });
});

test('approved membership is separate from the system role; staff cannot write', () => {
  const approved = { status: 'APPROVED' }, owner = { role: 'OWNER', revoked_at: null }, staff = { role: 'STAFF', revoked_at: null };
  requireMembership(approved, owner, { owner: true });
  requireMembership(approved, staff);
  assert.throws(() => requireMembership(approved, staff, { owner: true }), { code: 'OWNER_REQUIRED' });
  for (const membership of [null, { ...owner, revoked_at: new Date() }, { role: 'ADMIN' }]) assert.throws(() => requireMembership(approved, membership), { status: 404 });
  for (const status of ['PENDING', 'SUSPENDED']) assert.throws(() => requireMembership({ status }, owner), { code: 'ORGANIZER_NOT_APPROVED' });
});

test('cursor pages are bounded, reject unknown query fields and expose no total scan', () => {
  assert.deepEqual(parseInput(pageInput, {}), { limit: 20 });
  assert.deepEqual(parseInput(reviewInput, { limit: '2' }), { limit: 2, status: 'PENDING' });
  for (const query of [{ limit: '0' }, { limit: '51' }, { after: 'not-a-uuid' }, { role: 'ADMIN' }, { limit: ['1', '2'] }]) assert.throws(() => parseInput(pageInput, query), { status: 400 });
  assert.deepEqual(pageResult([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2), { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' });
  assert.deepEqual(pageResult([], 2), { items: [], nextCursor: null });
});

test('development admin grant refuses production/missing flag/bad email before connecting', async () => {
  const pool = { connect() { throw new Error('should never connect'); } };
  for (const env of [{ NODE_ENV: 'production', ALLOW_DEV_ADMIN: 'true' }, { NODE_ENV: 'development' }, { NODE_ENV: 'test', ALLOW_DEV_ADMIN: 'TRUE' }]) {
    await assert.rejects(grantDevelopmentAdmin(pool, env, 'reader@example.invalid'), { code: 'DEVELOPMENT_ADMIN_DISABLED' });
  }
  await assert.rejects(grantDevelopmentAdmin(pool, { ALLOW_DEV_ADMIN: 'true' }, 'invalid'), { code: 'INVALID_EMAIL' });
  assert.equal(requireDevelopmentAdmin({ NODE_ENV: 'development', ALLOW_DEV_ADMIN: 'true' }, ' Reader@Example.invalid '), 'reader@example.invalid');
});

test('organizer HTTP routes fail closed without a session and reject untrusted mutation origins before DB work', async () => {
  let calls = 0;
  const pool = { query() { calls++; throw new Error('unexpected DB access'); }, connect() { calls++; throw new Error('unexpected DB access'); } };
  const config = { NODE_ENV: 'test', AUTH_SECRET: 'a'.repeat(64), PUBLIC_ORIGIN: 'https://seatledger.test' };
  const server = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/api/organizers', '/api/admin/organizers', '/api/organizers/invalid/events', '/api/organizers/invalid/venues', '/api/organizers/invalid/events/invalid/shows', '/api/organizers/invalid/events/invalid/shows/invalid', '/api/organizers/invalid/events/invalid/publication', '/api/organizers/invalid/events/invalid/publication/status']) {
      const response = await fetch(base + path); assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'AUTH_REQUIRED' });
    }
    const headers = { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web' };
    assert.equal((await fetch(base + '/api/organizers', { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/organizers', { method: 'POST', headers: { ...headers, Origin: config.PUBLIC_ORIGIN }, body: '{}' })).status, 401);
    assert.equal(calls, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
