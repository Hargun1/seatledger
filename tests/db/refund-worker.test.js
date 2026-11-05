import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { claimOutbox } from '../../apps/api/src/reliability/outbox.js';
import { createSimulatedPayment } from '../../apps/api/src/payments/simulator.js';
import { createSimulatedRefund, simulatedRefundId } from '../../apps/api/src/payments/refund-simulator.js';
import { runRefundBatch, prepareRefundJob, finishRefundJob } from '../../apps/api/src/payments/refund-jobs.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('refund worker: two owners, unknown replies, audit rollback, stale/expired leases and invalid evidence preserve financial facts', { timeout: 30000 }, async () => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original);
  let admin, schema, pool, secondPool;
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin);
    for (const name of ['012_simulated_provider.sql', '016_simulated_refunds.sql']) await admin.query(await readFile(new URL('../../db/migrations/' + name, import.meta.url), 'utf8'));
    await admin.query('COMMIT'); const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = createPool(url.toString()); secondPool = createPool(url.toString());
    async function tx(work, target = pool) {
      const db = await target.connect(); try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
      catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }
    async function fixture({ legacy = false, maxAttempts = 8 } = {}) {
      const value = await tx(async db => {
        const f = await paymentFixture(db), reservation = await f.reservation();
        const pay = (await db.query(`INSERT INTO payment_attempts(reservation_id,user_id,show_id,amount_minor,currency)
          VALUES($1,$2,$3,75000,'INR') RETURNING *`, [reservation.id, f.user, f.show])).rows[0];
        return { f, pay };
      });
      let providerId = 'sim_legacy_' + value.pay.id;
      if (!legacy) {
        const receipt = await createSimulatedPayment(pool, { requestKey: value.pay.request_key, paymentAttemptId: value.pay.id, amountMinor: 75000, currency: 'INR' });
        providerId = receipt.providerPaymentId;
        await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (created_at+interval '100 milliseconds'-clock_timestamp())))+0.02)
          FROM simulated_provider_payments WHERE request_key=$1`, [value.pay.request_key]);
      }
      return tx(async db => {
        await db.query("UPDATE payment_attempts SET provider_payment_id=$2,status='SUCCEEDED',resolution='REFUND_REQUIRED',succeeded_at=clock_timestamp() WHERE id=$1", [value.pay.id, providerId]);
        const refund = (await db.query("INSERT INTO refunds(payment_attempt_id,amount_minor,currency,reason) VALUES($1,75000,'INR','INVENTORY_LOST') RETURNING *", [value.pay.id])).rows[0];
        const job = (await db.query("INSERT INTO outbox_events(kind,refund_id,operation_key,max_attempts) VALUES('REFUND_CREATE',$1,$2,$3) RETURNING *", [refund.id, refund.request_key, maxAttempts])).rows[0];
        return { ...value, refund, job };
      });
    }
    const batch = (options = {}, target = pool) => runRefundBatch(target, { workerId: 'refund-test', batchSize: 10, retryDelaySeconds: 0, ...options });
    const refund = async x => (await pool.query('SELECT * FROM refunds WHERE id=$1', [x.refund.id])).rows[0];
    const job = async x => (await pool.query('SELECT * FROM outbox_events WHERE id=$1', [x.job.id])).rows[0];
    const effectCount = async x => (await pool.query('SELECT count(*)::int AS n FROM simulated_provider_refunds WHERE request_key=$1', [x.refund.request_key])).rows[0].n;
    const audits = async x => (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='refund.completed'", [x.refund.id])).rows[0].n;
    const claim = async (workerId, leaseSeconds = 30) => (await tx(db => claimOutbox(db, { workerId, batchSize: 1, leaseSeconds, kinds: ['REFUND_CREATE'] })))[0];
    const expire = lease => pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (lease_expires_at-clock_timestamp())))+0.03) FROM outbox_events WHERE id=$1", [lease.id]);

    const race = await fixture();
    const raced = await Promise.all([batch({ workerId: 'refund-a' }), batch({ workerId: 'refund-b' }, secondPool)]);
    assert.equal(raced.reduce((n, c) => n + c.completed, 0), 1); assert.equal(raced.reduce((n, c) => n + c.failed, 0), 0);
    assert.equal((await refund(race)).status, 'SUCCEEDED'); assert.equal((await job(race)).status, 'SUCCEEDED');
    assert.equal(await effectCount(race), 1); assert.equal(await audits(race), 1); assert.equal((await batch()).claimed, 0);

    const lost = await fixture();
    const unknown = await batch({ provider: async (...args) => { await createSimulatedRefund(...args); throw new Error('fixture lost acknowledgement'); } });
    assert.equal(unknown.retryScheduled, 1); assert.equal((await refund(lost)).status, 'RETRYABLE_FAILURE');
    assert.equal(await effectCount(lost), 1); assert.equal(await audits(lost), 0);
    const recovered = await batch(); assert.equal(recovered.providerReplayed, 1); assert.equal(recovered.completed, 1);
    assert.equal((await refund(lost)).processing_attempts, 2); assert.equal(await effectCount(lost), 1); assert.equal(await audits(lost), 1);

    const rollback = await fixture();
    await pool.query(`CREATE FUNCTION reject_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.entity_id='${rollback.refund.id}'::uuid THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_refund_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_refund_audit()');
    assert.equal((await batch()).retryScheduled, 1); const failedAudit = await refund(rollback);
    assert.equal(failedAudit.status, 'RETRYABLE_FAILURE'); assert.equal(failedAudit.completed_at, null); assert.equal(failedAudit.provider_refund_id, null);
    assert.equal((await job(rollback)).status, 'RETRY_WAIT'); assert.equal(await effectCount(rollback), 1); assert.equal(await audits(rollback), 0);
    await pool.query('DROP TRIGGER reject_refund_audit ON audit_events'); await pool.query('DROP FUNCTION reject_refund_audit()');
    assert.equal((await batch()).completed, 1); assert.equal(await audits(rollback), 1);

    const stale = await fixture(), old = await claim('old-refund-owner', 1);
    assert.equal(old.id, stale.job.id); const input = await prepareRefundJob(pool, old), result = await createSimulatedRefund(pool, input);
    await expire(old); const current = await claim('new-refund-owner'); assert.notEqual(current.lease_token, old.lease_token);
    assert.equal(await finishRefundJob(secondPool, old, result), false);
    assert.equal((await refund(stale)).status, 'PROCESSING'); assert.equal(await audits(stale), 0);
    const resumedInput = await prepareRefundJob(pool, current), replay = await createSimulatedRefund(pool, resumedInput);
    assert.equal(replay.replayed, true); assert.equal(await finishRefundJob(secondPool, current, replay), true);
    assert.equal(await finishRefundJob(pool, current, replay), false); assert.equal(await audits(stale), 1);

    const crossing = await fixture(), deadlineJob = await claim('deadline-owner', 1);
    const deadlineInput = await prepareRefundJob(pool, deadlineJob), deadlineResult = await createSimulatedRefund(pool, deadlineInput);
    await pool.query('CREATE SEQUENCE refund_deadline_probe');
    await pool.query(`CREATE FUNCTION delay_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.entity_id='${crossing.refund.id}'::uuid THEN PERFORM nextval('refund_deadline_probe');
        PERFORM pg_sleep(GREATEST(0,(SELECT EXTRACT(epoch FROM (lease_expires_at-clock_timestamp())) FROM outbox_events WHERE id='${deadlineJob.id}'::uuid))+0.03);
      END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER delay_refund_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION delay_refund_audit()');
    await assert.rejects(finishRefundJob(pool, deadlineJob, deadlineResult));
    assert.equal((await pool.query('SELECT is_called FROM refund_deadline_probe')).rows[0].is_called, true);
    assert.equal((await refund(crossing)).status, 'PROCESSING'); assert.equal((await refund(crossing)).completed_at, null);
    assert.equal((await job(crossing)).status, 'PROCESSING'); assert.equal(await audits(crossing), 0); assert.equal(await effectCount(crossing), 1);
    await pool.query('DROP TRIGGER delay_refund_audit ON audit_events'); await pool.query('DROP FUNCTION delay_refund_audit()');
    assert.equal((await batch()).completed, 1);

    const forged = await fixture();
    const invalid = await batch({ provider: async (_pool, command) => ({ ...command, providerRefundId: simulatedRefundId(command.requestKey),
      refundedAt: new Date().toISOString(), providerState: 'SUCCEEDED', paymentMode: 'simulated', replayed: false }) });
    assert.equal(invalid.deadLettered, 1); assert.equal((await job(forged)).last_error_code, 'REFUND_PROVIDER_RESPONSE_INVALID');
    assert.equal((await refund(forged)).completed_at, null); assert.equal(await effectCount(forged), 0); assert.equal(await audits(forged), 0);
    const legacy = await fixture({ legacy: true });
    assert.equal((await batch()).deadLettered, 1); assert.equal((await job(legacy)).last_error_code, 'REFUND_JOB_INVALID');
    assert.equal((await refund(legacy)).status, 'REQUESTED'); assert.equal(await effectCount(legacy), 0);

    const exhausted = await fixture({ maxAttempts: 1 }), last = await claim('abandoned-last-attempt', 1);
    await prepareRefundJob(pool, last); await expire(last); await batch();
    assert.equal((await job(exhausted)).status, 'DEAD_LETTER'); assert.equal((await job(exhausted)).last_error_code, 'LEASE_EXHAUSTED');
    assert.equal((await refund(exhausted)).status, 'PROCESSING'); assert.equal((await refund(exhausted)).completed_at, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM show_seats WHERE state<>'AVAILABLE'")).rows[0].n, 0);
  } finally {
    if (pool) await pool.end(); if (secondPool) await secondPool.end();
    if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^reliability_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); }
    await adminPool.end();
  }
});
