import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { evidenceFixture } from '../../scripts/lib/evidence-fixture.js';

test('hosted runtime completes the signed payment pipeline and fails closed when a worker dies', { timeout: 45000 }, async () => {
  await evidenceFixture(async c => {
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const f = await c.catalogue(), actor = await c.actor(), started = new Map();
    const child = spawn(process.execPath, ['scripts/start-production.js'], { cwd: fileURLToPath(new URL('../../', import.meta.url)),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
        DATABASE_URL: c.connectionString, AUTH_SECRET: c.config.AUTH_SECRET, PUBLIC_ORIGIN: c.config.PUBLIC_ORIGIN,
        SIMULATOR_WEBHOOK_SECRET: c.config.SIMULATOR_WEBHOOK_SECRET, PAYMENT_MODE: 'simulated', SIMULATOR_SCENARIO: 'success' } });
    let ended = false, buffer = '';
    const exit = new Promise(resolve => { child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }); });
      child.once('error', () => { ended = true; resolve({ code: -1 }); }); });
    child.stderr.resume(); // Never dump runtime environment or private responses.
    child.stdout.on('data', chunk => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const row = JSON.parse(line); if (row.service === 'seatledger-runtime' && row.event === 'child-started'
          && typeof row.file === 'string' && Number.isInteger(row.pid)) started.set(row.file, row.pid); } catch { /* Other static startup output. */ }
      }
    });
    const wait = async check => { for (let i = 0; i < 150; i++) { if (await check()) return; if (ended) break; await delay(100); }
      throw new Error('Hosted runtime did not reach its expected state'); };
    c.origins[0] = `http://127.0.0.1:${port}`;
    try {
      await wait(async () => { try { return started.size === 7 && (await c.request(actor, '/api/ready')).status === 200; } catch { return false; } });
      const hold = await c.request(actor, '/api/reservations', { method: 'POST', body: { showId: f.show, seatIds: [f.seat] } });
      assert.equal(hold.status, 201); const reservation = await hold.json();
      const response = await c.request(actor, `/api/reservations/${reservation.id}/payment-attempts`, { method: 'POST', body: {} });
      assert.equal(response.status, 201); const payment = await response.json(); let saved;
      await wait(async () => { const read = await c.request(actor, '/api/payments/' + payment.id); assert.equal(read.status, 200);
        saved = await read.json(); return saved.resolution === 'BOOKED'; });
      assert.equal(saved.status, 'SUCCEEDED');
      assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM bookings WHERE reservation_id=$1', [reservation.id])).rows[0].n, 1);
      assert.equal((await c.pool.query('SELECT state FROM show_seats WHERE show_id=$1', [f.show])).rows[0].state, 'BOOKED');
      const workerPid = started.get('apps/api/src/payments/inbox-worker.js'); assert.ok(workerPid);
      process.kill(workerPid, 'SIGKILL');
      const result = await Promise.race([exit, delay(18000, undefined, { ref: false }).then(() => { throw new Error('Runtime group did not stop'); })]);
      assert.equal(result.code, 1, 'A partial worker group must not remain available');
      await assert.rejects(fetch(c.origins[0] + '/api/health', { signal: AbortSignal.timeout(2000) }));
    } finally {
      if (!ended) {
        // Terminating one owned grandchild lets the supervisor stop its whole
        // group even on Windows, where kill(SIGTERM) terminates a process.
        for (const pid of started.values()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        child.kill('SIGKILL'); await exit;
      }
    }
  });
});
