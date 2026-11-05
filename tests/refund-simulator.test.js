import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSimulatedRefund, simulatedRefundId } from '../apps/api/src/payments/refund-simulator.js';

test('simulated refund identities normalize UUIDs and invalid commands fail before any connection', async () => {
  const key = randomUUID(), first = simulatedRefundId(key);
  assert.match(first, /^sim_ref_[a-f0-9]{64}$/); assert.equal(first, simulatedRefundId(key.toUpperCase()));
  assert.notEqual(first, simulatedRefundId(randomUUID()));
  assert.throws(() => simulatedRefundId('not-a-key'), e => e.code === 'REFUND_INPUT_INVALID');
  let connected = false;
  const pool = { connect() { connected = true; throw new Error('Must not connect'); } };
  const valid = { requestKey: key, refundId: randomUUID(), paymentAttemptId: randomUUID(), providerPaymentId: 'sim_pay_' + 'a'.repeat(64), amountMinor: 75000, currency: 'INR' };
  for (const command of [{ ...valid, amountMinor: 0.5 }, { ...valid, amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, currency: 'inr' }, { ...valid, providerPaymentId: 'real-private-payment-value' }, { ...valid, extra: 'secret' }]) {
    await assert.rejects(createSimulatedRefund(pool, command), e => e.code === 'REFUND_INPUT_INVALID'
      && !e.retryable && !e.message.includes('secret') && !e.message.includes('private-payment'));
  }
  assert.equal(connected, false);
});
