import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFixture } from '../../scripts/lib/evidence-fixture.js';
import { traceParent } from '../../apps/api/src/observability.js';

test('request/database traces correlate, metrics require operator access, and telemetry excludes private data', async () => {
  const logs = [], logger = { info: row => logs.push(row), error: row => logs.push(row) };
  await evidenceFixture(async c => {
    const canary = 'PRIVATE_PASSWORD_AND_TOKEN_CANARY', trace = 'e'.repeat(32), upstream = 'f'.repeat(16);
    const ready = await fetch(c.origins[0] + '/api/ready?private=' + canary,
      { headers: { traceparent: `00-${trace}-${upstream}-01`, 'X-Private-Token': canary } });
    assert.equal(ready.status, 200); const responseTrace = traceParent(ready.headers.get('traceparent'));
    assert.equal(responseTrace.traceId, trace); assert.notEqual(responseTrace.spanId, upstream);
    assert.match(ready.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
    assert.equal(ready.headers.get('x-frame-options'), 'DENY');
    assert.equal(ready.headers.get('referrer-policy'), 'no-referrer');
    await ready.json();
    const root = logs.find(row => row.event === 'trace.span' && row.name === 'http.request' && row.traceId === trace);
    const db = logs.find(row => row.event === 'trace.span' && row.name === 'database.query' && row.traceId === trace);
    assert.equal(root.parentSpanId, upstream); assert.equal(db.parentSpanId, root.spanId); assert.equal(db.operation, 'SELECT');
    assert.ok(root.durationMs >= 0); assert.ok(db.durationMs >= 0);
    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const traceId = (index + 1).toString(16).padStart(32, '0');
      const response = await fetch(c.origins[0] + '/api/ready', { headers: { traceparent: `00-${traceId}-${upstream}-01` } });
      await response.json(); const own = traceParent(response.headers.get('traceparent'));
      assert.equal(own.traceId, traceId);
      assert.ok(logs.some(row => row.name === 'database.query' && row.traceId === traceId && row.parentSpanId === own.spanId), 'Queued database reads must retain their own request context');
    }));
    const stranger = await c.actor(), admin = await c.actor();
    await c.pool.query("UPDATE users SET system_role='ADMIN' WHERE id=$1", [admin.id]);
    assert.equal((await fetch(c.origins[0] + '/api/metrics')).status, 401);
    assert.equal((await c.request(stranger, '/api/metrics')).status, 403);
    const metrics = await c.request(admin, '/api/metrics'); assert.equal(metrics.status, 200);
    assert.equal(metrics.headers.get('cache-control'), 'no-store');
    const text = await metrics.text();
    assert.match(text, /seatledger_http_requests_total/); assert.match(text, /seatledger_http_request_duration_seconds_bucket/);
    assert.match(text, /seatledger_database_queries_total\{operation="SELECT"\}/);
    assert.match(text, /seatledger_database_pool_waiting/);
    c.config.METRICS_TOKEN = 'a'.repeat(64);
    assert.equal((await fetch(c.origins[0] + '/api/metrics', { headers: { Authorization: 'Bearer ' + c.config.METRICS_TOKEN } })).status, 200);
    assert.equal((await fetch(c.origins[0] + '/api/metrics', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 401);
    await fetch(c.origins[0] + '/unmatched/' + canary);
    await fetch(c.origins[0] + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' + canary });
    assert.ok(!JSON.stringify(logs).includes(canary)); assert.ok(!text.includes(canary));
    assert.ok(logs.some(row => row.event === 'http.request' && row.status === 404 && row.route === 'unmatched'));
    assert.ok(!JSON.stringify(logs).includes(c.connectionString));
    assert.ok(!JSON.stringify(logs).includes(c.config.METRICS_TOKEN));
  }, { logger, traceSampleRate: 1 });
});
