import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evidenceFixture } from '../../scripts/lib/evidence-fixture.js';

test('a force-terminated API restarts and replays its committed hold without renewal', { timeout: 30000 }, async () => {
  await evidenceFixture(async c => {
    const f = await c.catalogue(), person = await c.actor(), key = randomUUID(); let child, exit;
    async function start() {
      child = fork(fileURLToPath(new URL('../helpers/restart-api-child.js', import.meta.url)), [], { execArgv: [], windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: c.connectionString,
          AUTH_SECRET: c.config.AUTH_SECRET, SIMULATOR_WEBHOOK_SECRET: c.config.SIMULATOR_WEBHOOK_SECRET, PUBLIC_ORIGIN: c.config.PUBLIC_ORIGIN } });
      exit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: -1 })); });
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('API child did not start')), 10000);
        child.once('message', value => { clearTimeout(timer); if (value?.event === 'ready' && Number.isInteger(value.port)) resolve(value.port); else reject(new Error('Invalid fixture startup')); });
        child.once('error', () => { clearTimeout(timer); reject(new Error('API child unavailable')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('API child exited before ready')); });
      });
      c.origins[0] = `http://127.0.0.1:${port}`;
    }
    try {
      await start();
      const options = { method: 'POST', key, body: { showId: f.show, seatIds: [f.seat] } };
      const first = await c.request(person, '/api/reservations', options); assert.equal(first.status, 201); const saved = await first.json();
      assert.equal(child.kill('SIGKILL'), true); const killed = await exit; assert.ok(killed.signal || killed.code !== 0);
      await start();
      const replay = await c.request(person, '/api/reservations', options); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), saved);
      assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM reservations WHERE show_id=$1', [f.show])).rows[0].n, 1);
      assert.equal((await c.request(person, '/api/ready')).status, 200);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exit) await exit;
    }
  });
});
