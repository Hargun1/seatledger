import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../apps/api/src/db.js';
import { migrate } from './lib/migrations.js';
import { seedDevelopment } from './lib/seeds.js';
import { evidenceFixture } from './lib/evidence-fixture.js';
import { runPaymentBatch } from '../apps/api/src/payments/worker.js';
import { runDeliveryBatch } from '../apps/api/src/payments/delivery.js';
import { runInboxBatch } from '../apps/api/src/payments/processor.js';

const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const stamp = new Date().toISOString().replaceAll(':', '-');
const directory = new URL(`../test-results/operations/${stamp}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const project = 'seatledger-operations-' + randomUUID().replaceAll('-', '');
assert.match(project, /^seatledger-operations-[a-f0-9]{32}$/);
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
// Override any application DATABASE_URL with this disposable loopback target.
const env = { ...process.env, NODE_ENV: 'test', SEATLEDGER_VERIFY_PORT: String(port),
  DATABASE_URL: `postgresql://seatledger_verify:verification_only@127.0.0.1:${port}/seatledger_verify`,
  AUTH_SECRET: randomBytes(32).toString('hex'), SIMULATOR_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  SEATLEDGER_LOAD_CLIENTS: process.env.SEATLEDGER_LOAD_CLIENTS || '1000',
  SEATLEDGER_LOAD_CONCURRENCY: process.env.SEATLEDGER_LOAD_CONCURRENCY || '250' };
const report = { startedAt: new Date().toISOString(), synthetic: true, isolatedDatabase: true, checks: [],
  limitations: ['local two-instance HTTP hold workload; not a production capacity guarantee',
    'database outage uses pause/unpause; not disk loss or disaster recovery',
    'browser acceptance and physical devices are separate checks'] };
const save = () => writeFile(new URL('acceptance.json', directory), JSON.stringify(report, null, 2) + '\n');
async function run(label, command, args, timeout = 300000, overrides = {}) {
  const started = performance.now(); let result, code = 0;
  console.log('Checking ' + label);
  try { result = await execute(command, args, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { result = error; code = typeof error.code === 'number' ? error.code : 1; }
  await writeFile(new URL(label + '.log', directory), (result.stdout || '') + (result.stderr || ''));
  const totals = Object.fromEntries([...(result.stdout || '').matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gm)].map(m => [m[1], Number(m[2])]));
  const check = { label, code, durationMs: performance.now() - started, ...totals };
  report.checks.push(check); await save(); console.log(JSON.stringify(check));
  if (code) console.error(label + ' failed; see its local log.');
  return code;
}
const compose = (...args) => run('docker-' + args[0], 'docker', ['compose', '-f', 'compose.verify.yaml', '-p', project, ...args], 120000);
let pool;
try {
  if (await compose('up', '-d', '--wait', '--wait-timeout', '90')) throw new Error('DISPOSABLE_DATABASE_START_FAILED');
  pool = createPool(env.DATABASE_URL); await migrate(pool);
  await seedDevelopment(pool, { NODE_ENV: 'development', ALLOW_DEV_SEED: 'true' }); await pool.end(); pool = null;
  await run('units', process.execPath, ['--test', '--test-reporter=tap', 'tests/*.test.js']);
  const selected = process.env.SEATLEDGER_OPERATIONS_TEST_FILES?.split(',');
  const database = (await readdir(new URL('../tests/db/', import.meta.url))).filter(name => name.endsWith('.test.js') && (!selected || selected.includes(name))).sort().map(name => 'tests/db/' + name);
  assert.ok(database.length); if (selected) assert.equal(database.length, selected.length);
  report.databaseTestFiles = database;
  await run('database-security-worker-recovery', process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...database]);
  if (process.env.SEATLEDGER_OPERATIONS_BROWSER === 'true') {
    const build = await run('build', process.execPath, ['node_modules/vite/bin/vite.js', 'build', 'apps/web'], 120000, { NODE_ENV: 'production' });
    if (!build) {
      const browser = (await readdir(new URL('../tests/browser/', import.meta.url))).filter(name => name.endsWith('.test.js')).sort().map(name => 'tests/browser/' + name);
      await run('browser', process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...browser]);
    }
  }
  const evidenceDirectory = new URL('../test-results/evidence/', import.meta.url);
  const before = new Set(await readdir(evidenceDirectory).catch(() => []));
  await run('load', process.execPath, ['scripts/measure-load.js'], 300000, { NODE_ENV: 'production' });
  const files = (await readdir(evidenceDirectory)).filter(name => name.startsWith('load-') && !before.has(name));
  report.load = files.length === 1 ? JSON.parse(await readFile(new URL(files[0], evidenceDirectory), 'utf8')) : { passed: false, error: 'LOAD_PROCESS_DID_NOT_WRITE_REPORT' };
  // Keep a portable copy alongside this run's exact test and outage results.
  await writeFile(new URL('load.json', directory), JSON.stringify(report.load, null, 2));
  Object.assign(process.env, env);
  await evidenceFixture(async c => {
    const f = await c.catalogue(), actor = await c.actor();
    const hold = await c.request(actor, '/api/reservations', { method: 'POST', body: { showId: f.show, seatIds: [f.seat] } });
    assert.equal(hold.status, 201); const reservation = await hold.json();
    const response = await c.request(actor, `/api/reservations/${reservation.id}/payment-attempts`, { method: 'POST', body: {} });
    assert.equal(response.status, 201); const payment = await response.json();
    assert.equal((await c.pool.query('SELECT status FROM outbox_events WHERE payment_attempt_id=$1', [payment.id])).rows[0].status, 'READY');
    if (await compose('pause', 'db')) throw new Error('DATABASE_PAUSE_FAILED');
    try {
      assert.equal((await fetch(c.origins[0] + '/api/ready')).status, 503);
      assert.equal((await fetch(c.origins[0] + '/api/health')).status, 200);
      await assert.rejects(runPaymentBatch(c.pool, { workerId: 'outage-attempt' }));
    } finally { if (await compose('unpause', 'db')) throw new Error('DATABASE_UNPAUSE_FAILED'); }
    let ready = false;
    for (let i = 0; i < 10; i++) {
      if ((await fetch(c.origins[0] + '/api/ready')).status === 200) { ready = true; break; }
      await delay(250);
    }
    assert.ok(ready, 'The same API must recover without restarting');
    const batches = await Promise.all([runPaymentBatch(c.pools[0], { workerId: 'recovered-a' }), runPaymentBatch(c.pools[1], { workerId: 'recovered-b' })]);
    assert.equal(batches.reduce((n, b) => n + b.completed, 0), 1);
    assert.equal(batches.reduce((n, b) => n + b.failed, 0), 0);
    await c.pool.query('SELECT pg_sleep(.25)');
    assert.equal((await runDeliveryBatch(c.pool, { workerId: 'recovered-delivery', secret: c.config.SIMULATOR_WEBHOOK_SECRET,
      callbackUrl: c.origins[0] + '/api/payments/simulated/events' })).failed, 0);
    assert.equal((await runInboxBatch(c.pool)).failed, 0);
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM bookings WHERE reservation_id=$1', [reservation.id])).rows[0].n, 1);
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM simulated_provider_payments WHERE payment_attempt_id=$1', [payment.id])).rows[0].n, 1);
    report.databaseOutage = { passed: true, unavailableReadiness: 503, liveHealth: 200, apiRestarted: false,
      pendingJobRecovered: true, competingWorkers: 2, bookings: 1, providerEffects: 1 };
  }, { apiCount: 2 });
  report.passed = report.checks.every(check => check.code === 0) && report.load.passed && report.databaseOutage.passed;
} catch (error) { report.passed = false; report.failure = error.code || error.name; console.error('Operations verification failed; inspect the local evidence.'); }
finally {
  if (pool) await pool.end();
  const cleanup = await compose('down', '--remove-orphans');
  if (cleanup) report.passed = false;
  report.finishedAt = new Date().toISOString(); await save();
  console.log('Operations report: ' + fileURLToPath(new URL('acceptance.json', directory)));
  process.exitCode = report.passed ? 0 : 1;
}
