import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatorScenarios, simulatedPlan, simulatedPaymentId } from '../apps/api/src/payments/simulator.js';

test('simulated plans have stable identities, duplicate evidence and independent occurrence/delivery order', () => {
  const key = 'abcdefab-abcd-4abc-8abc-abcdefabcdea';
  assert.equal(simulatedPaymentId(key), simulatedPaymentId(key.toUpperCase()));
  for (const scenario of simulatorScenarios) {
    const plan = simulatedPlan(key, scenario); assert.deepEqual(plan, simulatedPlan(key.toUpperCase(), scenario)); assert.ok(plan.length >= 2 && plan.length <= 4);
  }
  const duplicate = simulatedPlan(key, 'duplicate'); assert.equal(duplicate[1].eventId, duplicate[2].eventId);
  assert.equal(duplicate[1].occurredAfterMs, duplicate[2].occurredAfterMs); assert.notEqual(duplicate[1].deliverAfterMs, duplicate[2].deliverAfterMs);
  const ordered = simulatedPlan(key, 'out-of-order'); assert.equal(ordered[0].kind, 'PAYMENT_SUCCEEDED'); assert.equal(ordered[1].kind, 'PAYMENT_PENDING'); assert.ok(ordered[0].occurredAfterMs > ordered[1].occurredAfterMs);
  assert.ok(simulatedPlan(key, 'delayed-success')[1].deliverAfterMs > 300000);
  assert.throws(() => simulatedPlan(key, 'arbitrary')); assert.throws(() => simulatedPlan('bad', 'success'));
});
