import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../apps/api/src/db.js';
import { createApp } from '../apps/api/src/app.js';
import { migrate } from './lib/migrations.js';
import { seedDevelopment } from './lib/seeds.js';

const execute = promisify(execFile);
const project = `seatledger-verify-${randomUUID().replaceAll('-', '')}`;
const composeFile = fileURLToPath(new URL('../compose.verify.yaml', import.meta.url));
let verificationPort;
async function compose(...args) {
  try {
    return await execute('docker', ['compose', '-f', composeFile, '-p', project, ...args], {
      timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, SEATLEDGER_VERIFY_PORT: String(verificationPort) }
    });
  } catch (error) {
    throw new Error(`Verifier Docker command failed: ${error.stderr || error.message}`);
  }
}

let pool;
let server;
let cleanupNeeded = false;
let failed = false;
try {
  console.log(`Temporary verification project: ${project}`);
  const portProbe = createServer();
  await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
  verificationPort = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  cleanupNeeded = true;
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  const { stdout } = await compose('port', 'db', '5432');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(stdout.trim());
  assert.ok(match, 'Expected a loopback-only temporary database port');
  assert.equal(Number(match[1]), verificationPort, 'Verifier must retain its chosen database port');
  // Never reads DATABASE_URL: cannot target the working application database.
  pool = createPool(`postgresql://seatledger_verify:verification_only@127.0.0.1:${match[1]}/seatledger_verify`);
  pool.on('error', () => {}); // Expected idle errors while stopping the test DB.
  await migrate(pool);
  const applied = await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  await migrate(pool);
  assert.deepEqual((await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows, applied.rows);
  console.log('PASS: empty database migrates; replay preserves migration history');

  const seedEnv = { NODE_ENV: 'development', ALLOW_DEV_SEED: 'true' };
  const snapshotSql = `SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM organizers) AS organizers,
    (SELECT count(*)::int FROM organizer_memberships) AS memberships,
    (SELECT count(*)::int FROM venues) AS venues,
    (SELECT count(*)::int FROM venue_sections) AS sections,
    (SELECT count(*)::int FROM venue_seats) AS seats,
    (SELECT count(*)::int FROM events) AS events,
    (SELECT count(*)::int FROM shows) AS shows,
    (SELECT count(*)::int FROM show_seats) AS inventory,
    (SELECT jsonb_agg(s ORDER BY show_id, venue_seat_id) FROM show_seats s) AS allocations`;
  await seedDevelopment(pool, seedEnv);
  const first = (await pool.query(snapshotSql)).rows[0];
  assert.deepEqual(Object.fromEntries(Object.entries(first).filter(([key]) => key !== 'allocations')),
    { users: 3, organizers: 4, memberships: 2, venues: 3, sections: 3, seats: 48, events: 3, shows: 3, inventory: 48 });
  await seedDevelopment(pool, seedEnv);
  assert.deepEqual((await pool.query(snapshotSql)).rows[0], first);
  console.log('PASS: seed twice preserves exact counts, seat IDs, prices and allocation state');

  const dbTests = (await readdir(new URL('../tests/db/', import.meta.url)))
    .filter(name => name.endsWith('.test.js')).sort().map(name => `tests/db/${name}`);
  try {
    // Match test:db's file isolation while retaining each fixture's internal
    // two-API/worker concurrency. The full suite has grown beyond the original
    // 30-second wrapper budget; individual test deadlines stay unchanged.
    const checks = execute(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...dbTests], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: pool.options.connectionString },
      timeout: 180000
    });
    // Stream TAP so a stuck fixture cannot hide the original assertion until
    // the outer watchdog ends. Retain the child's normal nonzero exit.
    checks.child.stdout.pipe(process.stdout);
    checks.child.stderr.pipe(process.stderr);
    await checks;
  } catch (error) {
    console.error(JSON.stringify({ event: 'db-checks-failed',
      code: typeof error.code === 'number' ? error.code : 'RUNNER_ERROR',
      killed: Boolean(error.killed), signal: error.signal ?? null }));
    throw new Error('Real PostgreSQL checks failed; see test output above.');
  }
  console.log('PASS: real PostgreSQL fixture and constraint checks');

  server = createApp({ pool, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  assert.equal((await get('/api/ready')).status, 200);
  await compose('stop', 'db');
  const unavailable = await get('/api/ready');
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: 'unavailable', database: 'unavailable', paymentMode: 'simulated' });
  assert.equal((await get('/api/health')).status, 200);
  // A tmpfs may be cleared on stop. Rebuild the disposable schema on recovery
  // so readiness cannot conceal a database that has lost its application tables.
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  assert.equal((await compose('port', 'db', '5432')).stdout.trim(), `127.0.0.1:${verificationPort}`,
    'Database restart must preserve the API connection destination');
  let recovered = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if ((await get('/api/ready')).status === 200) { recovered = true; break; }
    await delay(500);
  }
  assert.ok(recovered, 'Readiness should recover without restarting the API');
  await migrate(pool);
  await seedDevelopment(pool, seedEnv);
  assert.deepEqual((await pool.query(snapshotSql)).rows[0].inventory, 48);
  console.log('PASS: database outage gives readiness 503/liveness 200; readiness recovers');
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  try {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
  } finally {
    if (cleanupNeeded) {
      try { await compose('down', '--remove-orphans'); }
      catch (error) { failed = true; console.error(`Cleanup failed for ${project}: ${error.message}`); }
    }
    process.exitCode = failed ? 1 : 0;
  }
}
