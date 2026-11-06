import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evidenceFixture } from '../../scripts/lib/evidence-fixture.js';

test('two worker processes claim one durable job once, emit traces and ignore a later duplicate poll', { timeout: 20000 }, async () => {
  await evidenceFixture(async c => {
    const f = await c.catalogue(), actor = await c.actor();
    const held = await c.request(actor, '/api/reservations', { method: 'POST', body: { showId: f.show, seatIds: [f.seat] } });
    assert.equal(held.status, 201); const reservation = await held.json();
    const paid = await c.request(actor, `/api/reservations/${reservation.id}/payment-attempts`, { method: 'POST', body: {} });
    assert.equal(paid.status, 201); const payment = await paid.json();
    const job = (await c.pool.query('SELECT id FROM outbox_events WHERE payment_attempt_id=$1', [payment.id])).rows[0];
    const run = async () => {
      const result = await promisify(execFile)(process.execPath, ['apps/api/src/payments/outbox-worker.js', '--once'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true, timeout: 10000,
        env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: c.connectionString, TRACE_SAMPLE_RATE: '1' }
      });
      assert.equal(result.stderr, '');
      const logs = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      return { batch: logs.find(row => row.service === 'seatledger-simulated-payments' && row.event === 'batch'), logs };
    };
    const workers = await Promise.all([run(), run()]);
    assert.equal(workers.reduce((n, worker) => n + worker.batch.completed, 0), 1);
    assert.equal(workers.reduce((n, worker) => n + worker.batch.failed, 0), 0);
    assert.equal((await run()).batch.claimed, 0);
    const spans = workers.flatMap(worker => worker.logs).filter(row => row.event === 'trace.span');
    const jobSpan = spans.find(row => row.name === 'worker.payment.create');
    assert.equal(jobSpan.traceId, job.id.replaceAll('-', ''));
    assert.ok(spans.some(row => row.name === 'database.query' && row.parentSpanId === jobSpan.spanId));
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM simulated_provider_payments WHERE payment_attempt_id=$1', [payment.id])).rows[0].n, 1);
    const row = (await c.pool.query('SELECT status,attempt_count FROM outbox_events WHERE id=$1', [job.id])).rows[0];
    assert.deepEqual(row, { status: 'SUCCEEDED', attempt_count: 1 });
  });
});
