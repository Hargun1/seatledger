import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createSimulatedPayment } from '../../apps/api/src/payments/simulator.js';
import { createSimulatedRefund, simulatedRefundId } from '../../apps/api/src/payments/refund-simulator.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('simulated full-refund effects commit independently, replay concurrently and never duplicate a captured payment', { timeout: 30000 }, async () => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original);
  let admin, schema, pool, caller;
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN');
    schema = await installReliabilitySchema(admin);
    for (const name of ['012_simulated_provider.sql', '016_simulated_refunds.sql']) {
      await admin.query(await readFile(new URL('../../db/migrations/' + name, import.meta.url), 'utf8'));
    }
    await admin.query('COMMIT');
    const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(url.toString());
    async function source(scenario = 'success') {
      return createSimulatedPayment(pool, { requestKey: randomUUID(), paymentAttemptId: randomUUID(), amountMinor: 75000, currency: 'INR', scenario });
    }
    async function waitForCapture(payment) {
      const success = payment.plan.find(e => e.kind === 'PAYMENT_SUCCEEDED');
      // Wait only for this saved simulated schedule; no production budget changes.
      await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (created_at+($2::integer*interval '1 millisecond')-clock_timestamp())))+0.02)
        FROM simulated_provider_payments WHERE request_key=$1`, [payment.requestKey, success.occurredAfterMs]);
    }
    const commandFor = payment => ({ requestKey: randomUUID(), refundId: randomUUID(), paymentAttemptId: payment.paymentAttemptId,
      providerPaymentId: payment.providerPaymentId, amountMinor: payment.amountMinor, currency: payment.currency });
    const payment = await source(); await waitForCapture(payment); const command = commandFor(payment);
    const results = await Promise.all(Array.from({ length: 8 }, () => createSimulatedRefund(pool, command)));
    assert.equal(results.filter(r => !r.replayed).length, 1); assert.equal(results.filter(r => r.replayed).length, 7);
    const first = results.find(r => !r.replayed), stable = ({ replayed, ...rest }) => rest;
    assert.ok(results.every(r => r.paymentMode === 'simulated' && r.providerState === 'SUCCEEDED'));
    assert.ok(results.every(r => JSON.stringify(stable(r)) === JSON.stringify(stable(first))));
    assert.equal(first.providerRefundId, simulatedRefundId(command.requestKey));
    const uppercase = { ...command, requestKey: command.requestKey.toUpperCase(), refundId: command.refundId.toUpperCase(), paymentAttemptId: command.paymentAttemptId.toUpperCase() };
    assert.equal((await createSimulatedRefund(pool, uppercase)).replayed, true);
    for (const changed of [{ ...command, amountMinor: 1 }, { ...command, requestKey: randomUUID() },
      { ...command, requestKey: randomUUID(), refundId: randomUUID() }]) {
      await assert.rejects(createSimulatedRefund(pool, changed), e => e.code === 'REFUND_IDENTITY_CONFLICT' && !e.retryable);
    }
    assert.deepEqual((await pool.query('SELECT count(*)::int AS n,sum(amount_minor)::text AS amount FROM simulated_provider_refunds')).rows[0], { n: 1, amount: '75000' });

    const secondPayment = await source(); await waitForCapture(secondPayment); const second = commandFor(secondPayment);
    await assert.rejects(createSimulatedRefund(pool, { ...second, refundId: command.refundId }), e => e.code === 'REFUND_IDENTITY_CONFLICT');
    for (const changed of [{ ...second, amountMinor: 1 }, { ...second, currency: 'USD' }, { ...second, paymentAttemptId: randomUUID() }]) {
      await assert.rejects(createSimulatedRefund(pool, changed), e => e.code === 'REFUND_CAPTURE_INVALID');
    }
    await assert.rejects(createSimulatedRefund(pool, { ...second, providerPaymentId: 'sim_pay_' + '0'.repeat(64) }), e => e.code === 'REFUND_PAYMENT_UNKNOWN');
    const failed = await source('failure');
    await assert.rejects(createSimulatedRefund(pool, commandFor(failed)), e => e.code === 'REFUND_CAPTURE_UNAVAILABLE' && !e.retryable);
    const future = await source('delayed-success');
    await assert.rejects(createSimulatedRefund(pool, commandFor(future)), e => e.code === 'REFUND_CAPTURE_PENDING' && e.retryable);

    // A caller rolls back and loses its response AFTER the independent provider
    // commit. This models the boundary; it is not a native socket/crash test.
    caller = await pool.connect(); await caller.query('BEGIN');
    await caller.query('CREATE TABLE refund_caller_probe(id uuid PRIMARY KEY)');
    await caller.query('INSERT INTO refund_caller_probe(id) VALUES($1)', [second.refundId]);
    let committed;
    try {
      await assert.rejects(async () => {
        committed = await createSimulatedRefund(pool, second);
        throw new Error('Simulated lost provider acknowledgement');
      }, /Simulated lost provider acknowledgement/);
    } finally { await caller.query('ROLLBACK'); caller.release(); caller = null; }
    assert.equal(committed.replayed, false);
    assert.equal((await pool.query('SELECT to_regclass($1) AS name', [schema + '.refund_caller_probe'])).rows[0].name, null);
    const recovered = await createSimulatedRefund(pool, second); assert.equal(recovered.replayed, true);
    assert.deepEqual(stable(recovered), stable(committed));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM simulated_provider_refunds')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refunds')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n, 0);
    await assert.rejects(pool.query('DELETE FROM simulated_provider_refunds WHERE request_key=$1', [command.requestKey]), e => e.code === '23514');
    await assert.rejects(pool.query('UPDATE simulated_provider_refunds SET currency=currency WHERE request_key=$1', [command.requestKey]), e => e.code === '23514');
    const badKey = randomUUID();
    await assert.rejects(pool.query(`INSERT INTO simulated_provider_refunds
      (request_key,refund_id,payment_attempt_id,provider_payment_id,provider_refund_id,request_hash,amount_minor,currency)
      VALUES($1,$2,$3,$4,$5,$6,1,'INR')`,
    [badKey, randomUUID(), future.paymentAttemptId, future.providerPaymentId, simulatedRefundId(badKey), Buffer.alloc(32)]), e => e.code === '23503');
  } finally {
    if (caller) { await caller.query('ROLLBACK'); caller.release(); }
    if (pool) await pool.end();
    if (admin) {
      await admin.query('ROLLBACK');
      if (schema) { assert.match(schema, /^reliability_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      admin.release();
    }
    await adminPool.end();
  }
});
