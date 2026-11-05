import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createSimulatedPayment, simulatedPaymentId } from '../../apps/api/src/payments/simulator.js';
import { runPaymentBatch, finishPaymentJob } from '../../apps/api/src/payments/worker.js';
import { claimOutbox } from '../../apps/api/src/reliability/outbox.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { paymentFixture } from '../helpers/payment-fixture.js';

test('simulated provider/outbox recovery with real PostgreSQL and process termination', { timeout: 60000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL), pools = []; let admin, schema, f, pool, url;
  async function enqueue() {
    await admin.query('BEGIN');
    try {
      const res = await f.reservation();
      const pay = (await admin.query(`INSERT INTO payment_attempts(reservation_id,show_id,user_id,amount_minor,currency)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [res.id, f.show, f.user, res.total_minor, res.currency])).rows[0];
      const job = (await admin.query("INSERT INTO outbox_events(kind,payment_attempt_id,operation_key) VALUES('PAYMENT_CREATE',$1,$2) RETURNING *", [pay.id, pay.request_key])).rows[0];
      await admin.query('COMMIT'); return { pay, job };
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
  }
  const input = pay => ({ requestKey: pay.request_key, paymentAttemptId: pay.id, amountMinor: Number(pay.amount_minor), currency: pay.currency, scenario: 'success' });
  const attempt = async id => (await pool.query('SELECT status,provider_payment_id FROM payment_attempts WHERE id=$1', [id])).rows[0];
  const jobState = async id => (await pool.query('SELECT status,attempt_count,lease_token FROM outbox_events WHERE id=$1', [id])).rows[0];
  const effectCount = async key => (await pool.query('SELECT count(*)::int AS n FROM simulated_provider_payments WHERE request_key=$1', [key])).rows[0].n;
  async function claim(workerId, leaseSeconds) {
    await admin.query('BEGIN');
    try { const rows = await claimOutbox(admin, { workerId, batchSize: 1, leaseSeconds, kinds: ['PAYMENT_CREATE'] }); await admin.query('COMMIT'); return rows[0]; }
    catch (error) { await admin.query('ROLLBACK'); throw error; }
  }
  const expireLease = id => admin.query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (lease_expires_at-clock_timestamp())))+0.03) FROM outbox_events WHERE id=$1", [id]);
  const batch = (options = {}, target = pool) => runPaymentBatch(target, { workerId: 'worker-' + randomUUID(), batchSize: 5, leaseSeconds: 5, retryDelaySeconds: 0, ...options });
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin);
    await admin.query(await readFile(new URL('../../db/migrations/012_simulated_provider.sql', import.meta.url), 'utf8'));
    f = await paymentFixture(admin); await admin.query('COMMIT');
    url = new URL(readDatabaseConfig().DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema},public`);
    for (let i = 0; i < 2; i++) pools.push(createPool(url.toString())); pool = pools[0];

    await t.test('provider effects commit once across calls, preserve the first plan and refuse identity changes or mutation', async () => {
      const request = { requestKey: randomUUID(), paymentAttemptId: randomUUID(), amountMinor: 75000, currency: 'INR', scenario: 'duplicate' };
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => createSimulatedPayment(pools[index % pools.length], request)));
      assert.equal(results.filter(r => !r.replayed).length, 1);
      assert.equal(results.filter(r => r.replayed).length, 7);
      const { replayed: ignored, ...first } = results[0];
      for (const result of results) { const { replayed, ...saved } = result; assert.deepEqual(saved, first); }
      assert.equal(await effectCount(request.requestKey), 1);
      const repeated = await createSimulatedPayment(pool, { ...request, scenario: 'failure' }); assert.equal(repeated.scenario, 'duplicate'); assert.equal(repeated.replayed, true);
      await assert.rejects(createSimulatedPayment(pool, { ...request, amountMinor: 1 }), e => e.code === 'PROVIDER_IDENTITY_CONFLICT');
      await admin.query('BEGIN');
      try { await assert.rejects(admin.query('UPDATE simulated_provider_payments SET scenario=scenario WHERE request_key=$1', [request.requestKey]), e => e.code === '23514'); }
      finally { await admin.query('ROLLBACK'); }
      assert.equal(await effectCount(request.requestKey), 1);
    });
    await t.test('two workers finish separate creation jobs as PENDING and leave refund work and failed payment state alone', async () => {
      const a = await enqueue(), b = await enqueue(); await pool.query("UPDATE payment_attempts SET status='FAILED' WHERE id=$1", [b.pay.id]);
      await admin.query('BEGIN'); let refundJob;
      try {
        const pay = await f.attempt(await f.reservation()); await f.capture(pay); const refund = await f.refund(pay);
        refundJob = (await admin.query("INSERT INTO outbox_events(kind,refund_id,operation_key,max_attempts) VALUES('REFUND_CREATE',$1,$2,1) RETURNING *", [refund.id, refund.request_key])).rows[0];
        await admin.query('COMMIT');
      } catch (error) { await admin.query('ROLLBACK'); throw error; }
      const results = await Promise.all(pools.map(p => batch({ batchSize: 1 }, p)));
      assert.equal(results.reduce((n, r) => n + r.completed, 0), 2); assert.equal(results.reduce((n, r) => n + r.failed, 0), 0);
      assert.deepEqual(await attempt(a.pay.id), { status: 'PENDING', provider_payment_id: simulatedPaymentId(a.pay.request_key) });
      assert.equal((await attempt(b.pay.id)).status, 'FAILED');
      assert.equal((await jobState(a.job.id)).status, 'SUCCEEDED'); assert.equal((await jobState(b.job.id)).status, 'SUCCEEDED');
      assert.equal((await jobState(refundJob.id)).attempt_count, 0);
      // Even exhausted refund leases must not be dead-lettered by this worker.
      await admin.query('BEGIN'); await claimOutbox(admin, { workerId: 'refund-fixture', batchSize: 1, leaseSeconds: 1, kinds: ['REFUND_CREATE'] }); await admin.query('COMMIT');
      await expireLease(refundJob.id); assert.equal((await batch()).claimed, 0); assert.equal((await jobState(refundJob.id)).status, 'PROCESSING');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
    });
    await t.test('lost provider acknowledgement and finalization failure retry one effect; invalid identity dead-letters safely', async () => {
      const lost = await enqueue();
      const failed = await batch({ provider: async (...args) => { await createSimulatedPayment(...args); throw new Error('simulated lost acknowledgement'); } });
      assert.equal(failed.retryScheduled, 1); assert.equal(failed.completed, 0); assert.equal(await effectCount(lost.pay.request_key), 1);
      assert.equal((await attempt(lost.pay.id)).status, 'CREATED'); assert.equal((await jobState(lost.job.id)).status, 'RETRY_WAIT');
      const retried = await batch({ scenario: 'failure' }); assert.equal(retried.providerReplayed, 1); assert.equal(retried.completed, 1);
      assert.equal(await effectCount(lost.pay.request_key), 1);
      const atomic = await enqueue();
      await admin.query(`CREATE FUNCTION fail_pending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status='PENDING' THEN RAISE EXCEPTION 'fixture finalization failure'; END IF; RETURN NEW; END $$`);
      await admin.query('CREATE TRIGGER fail_pending BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION fail_pending()');
      try {
        const result = await batch(); assert.equal(result.retryScheduled, 1); assert.equal(result.completed, 0);
        assert.equal((await attempt(atomic.pay.id)).status, 'CREATED'); assert.equal((await jobState(atomic.job.id)).status, 'RETRY_WAIT');
      } finally { await admin.query('DROP TRIGGER fail_pending ON payment_attempts'); await admin.query('DROP FUNCTION fail_pending()'); }
      assert.equal((await batch()).providerReplayed, 1); assert.equal((await jobState(atomic.job.id)).status, 'SUCCEEDED');
      const bad = await enqueue();
      const invalid = await batch({ provider: async (...args) => ({ ...await createSimulatedPayment(...args), amountMinor: 1 }) });
      assert.equal(invalid.deadLettered, 1); assert.equal((await jobState(bad.job.id)).status, 'DEAD_LETTER'); assert.equal((await attempt(bad.pay.id)).status, 'CREATED');
    });
    await t.test('expired lease cannot change the payment or new lease; the new owner can finish the same effect', async () => {
      const f = await enqueue(), original = await claim('stale-worker', 1), result = await createSimulatedPayment(pool, input(f.pay));
      assert.equal(original.id, f.job.id); await expireLease(original.id);
      const current = await claim('new-owner', 5); assert.notEqual(current.lease_token, original.lease_token);
      assert.equal(await finishPaymentJob(pool, original, result), false);
      assert.deepEqual(await attempt(f.pay.id), { status: 'CREATED', provider_payment_id: null });
      assert.equal((await jobState(current.id)).lease_token, current.lease_token);
      assert.equal(await finishPaymentJob(pool, current, result), true); assert.equal((await attempt(f.pay.id)).status, 'PENDING'); assert.equal(await effectCount(f.pay.request_key), 1);
    });
    await t.test('force-terminated worker after provider commit is recovered by a fresh CLI process without another effect', async () => {
      const f = await enqueue(), cwd = fileURLToPath(new URL('../../', import.meta.url));
      const env = { ...process.env, DATABASE_URL: url.toString(), PAYMENT_MODE: 'simulated', PAYMENT_WORKER_BATCH_SIZE: '1', PAYMENT_WORKER_LEASE_SECONDS: '5', PAYMENT_WORKER_POLL_MS: '1000', SIMULATOR_SCENARIO: 'failure' };
      const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'tests/helpers/payment-worker-crash-child.js'], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', () => resolve({ code: -1, signal: null }));
      }); let timer;
      try {
        await new Promise((resolve, reject) => {
          let output = ''; timer = setTimeout(() => reject(new Error('Crash fixture did not reach committed provider marker')), 10000);
          child.stdout.on('data', chunk => { output += chunk; if (output.includes('"provider-committed"')) resolve(); });
          child.once('error', () => reject(new Error('Crash fixture could not start')));
          child.once('exit', () => reject(new Error('Crash fixture exited before termination')));
        }); clearTimeout(timer);
        assert.equal(await effectCount(f.pay.request_key), 1); assert.equal((await attempt(f.pay.id)).status, 'CREATED');
        assert.equal(child.kill('SIGKILL'), true); const exit = await exited; assert.ok(exit.signal || exit.code !== 0);
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
      await expireLease(f.job.id);
      const run = async () => {
        const result = await promisify(execFile)(process.execPath, ['--env-file-if-exists=.env', 'apps/api/src/payments/outbox-worker.js', '--once'], { cwd, env, windowsHide: true, timeout: 10000 });
        assert.equal(result.stderr, ''); const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(records.at(-1).event, 'stopped'); return records.find(r => r.event === 'batch');
      };
      const recovered = await run(); assert.equal(recovered.providerReplayed, 1); assert.equal(recovered.completed, 1); assert.equal(recovered.failed, 0);
      assert.equal(await effectCount(f.pay.request_key), 1); assert.equal((await attempt(f.pay.id)).status, 'PENDING'); assert.equal((await jobState(f.job.id)).attempt_count, 2);
      const provider = (await pool.query('SELECT scenario FROM simulated_provider_payments WHERE request_key=$1', [f.pay.request_key])).rows[0]; assert.equal(provider.scenario, 'delayed-success');
      assert.equal((await run()).claimed, 0); assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE payment_attempt_id=$1', [f.pay.id])).rows[0].n, 0);
    });
  } finally {
    for (const p of pools) await p.end();
    if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^reliability_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); }
    await adminPool.end();
  }
});
