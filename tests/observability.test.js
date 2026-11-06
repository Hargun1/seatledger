import test from 'node:test';
import assert from 'node:assert/strict';
import { traceParent, validMetricsToken } from '../apps/api/src/observability.js';
import { retryDelaySeconds } from '../apps/api/src/reliability/retry.js';
import { createApp } from '../apps/api/src/app.js';

test('trace and scraper credentials reject malformed, zero, injected and unequal values', () => {
  const trace = 'a'.repeat(32), span = 'b'.repeat(16);
  assert.deepEqual(traceParent(`00-${trace}-${span}-01`), { traceId: trace, spanId: span });
  for (const value of [null, '', `00-${'0'.repeat(32)}-${span}-01`, `00-${trace}-${'0'.repeat(16)}-00`,
    `00-${trace}-${span}-01\nsecret`, `00-${trace.toUpperCase()}-${span}-01`]) assert.equal(traceParent(value), null);
  const token = 'c'.repeat(64);
  assert.equal(validMetricsToken('Bearer ' + token, token), true);
  for (const value of [undefined, token, 'Bearer ' + 'd'.repeat(64), 'Bearer ' + token + '\n']) assert.equal(validMetricsToken(value, token), false);
  assert.equal(validMetricsToken('Bearer ' + token, undefined), false);
});

test('worker retries back off with jitter, cap the wait and retain explicit immediate test retries', () => {
  assert.equal(retryDelaySeconds(1, 5, () => .5), 5);
  assert.equal(retryDelaySeconds(4, 5, () => .5), 40);
  assert.equal(retryDelaySeconds(2, 5, () => 0), 8);
  assert.equal(retryDelaySeconds(2, 5, () => 1), 12);
  assert.equal(retryDelaySeconds(100, 5, () => 1), 3600);
  assert.equal(retryDelaySeconds(1, 0), 0);
  for (const args of [[0], [-1], [1,-1], [1,3601]]) assert.throws(() => retryDelaySeconds(...args), TypeError);
});

test('pool pressure is a bounded service-busy response, while liveness stays available', async () => {
  const pool = { query: async () => { throw new Error('timeout exceeded when trying to connect'); } };
  const app = createApp({ pool, logger: { info() {}, error() {} }, config: {
    NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://127.0.0.1', AUTH_SECRET: 'a'.repeat(64)
  } }).listen(0, '127.0.0.1');
  await new Promise(resolve => app.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const response = await fetch(base + '/api/events');
    assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), { error: 'CATALOG_UNAVAILABLE' });
    const session = await fetch(base + '/api/auth/session', { headers: { Cookie: 'seatledger_session=' + 'a'.repeat(43) } });
    assert.equal(session.status, 503); assert.deepEqual(await session.json(), { error: 'DATABASE_BUSY' });
    assert.equal((await fetch(base + '/api/health')).status, 200);
  } finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});
