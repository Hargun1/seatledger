import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { createSimulatedEvent, encodeSimulatedEvent, signSimulatedDelivery, verifySimulatedDelivery,
  SimulatedEventError, MAX_SIMULATED_EVENT_BYTES } from '../apps/api/src/payments/events.js';
import { simulatedPaymentId, simulatedPlan, simulatorScenarios } from '../apps/api/src/payments/simulator.js';

const secret = '0f'.repeat(32), nowMs = Date.parse('2026-11-01T10:00:00.000Z');
const requestKey = 'abcdefab-abcd-4abc-8abc-abcdefabcdea';
const receipt = { requestKey, paymentAttemptId: '12345678-1234-4123-8123-123456789abc',
  providerPaymentId: simulatedPaymentId(requestKey), amountMinor: 24690, currency: 'INR',
  createdAt: '2026-11-01T09:00:00.123456Z', paymentMode: 'simulated' };
const rejects = (fn, code) => assert.throws(fn, error => error instanceof SimulatedEventError && error.code === code
  && !error.message.includes(secret));
const signed = (body, clock = nowMs) => signSimulatedDelivery(body, { secret, nowMs: clock });
const verified = (body, signature, clock = nowMs) => verifySimulatedDelivery(body, signature, { secret, nowMs: clock });

test('signed simulated events preserve immutable evidence across retries and verify exact bytes before parsing', () => {
  for (const scenario of simulatorScenarios) {
    for (const entry of simulatedPlan(requestKey, scenario)) {
      const event = createSimulatedEvent(receipt, entry), body = encodeSimulatedEvent(event);
      assert.equal(event.paymentMode, 'simulated'); assert.equal(event.amountMinor, 24690);
      assert.ok(!('deliverAfterMs' in event)); assert.ok(!('requestKey' in event));
      const result = verified(body, signed(body)); assert.deepEqual(result.event, event);
      assert.deepEqual(result.payloadHash, createHash('sha256').update(body).digest());
      // Independent framing check, including timestamp and domain separation.
      const digest = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update('seatledger.simulated-payment.v1\n1793527200\n').update(body).digest('hex');
      assert.equal(signed(body), `t=1793527200,v1=${digest}`);
    }
  }
  const duplicate = simulatedPlan(requestKey, 'duplicate');
  const body = encodeSimulatedEvent(createSimulatedEvent(receipt, duplicate[1]));
  assert.deepEqual(body, encodeSimulatedEvent(createSimulatedEvent(receipt, duplicate[2])));
  const later = nowMs + 360000, laterSignature = signed(body, later);
  assert.notEqual(signed(body), laterSignature);
  assert.deepEqual(verified(body, signed(body)).payloadHash, verified(body, laterSignature, later).payloadHash);
  assert.equal(verified(body, laterSignature, later).event.occurredAt, '2026-11-01T09:00:00.223Z');
  // Old occurrence is acceptable; only this delivery's signed timestamp ages out.
  verified(body, signed(body), nowMs + 300000); verified(body, signed(body), nowMs - 300000);
  rejects(() => verified(body, signed(body), nowMs + 301000), 'STALE_EVENT_DELIVERY');
  rejects(() => verified(body, signed(body), nowMs - 301000), 'STALE_EVENT_DELIVERY');
  rejects(() => verified(Buffer.from(body.toString().replace('24690', '24691')), signed(body)), 'INVALID_EVENT_SIGNATURE');
  rejects(() => verifySimulatedDelivery(body, signed(body), { secret: '1f'.repeat(32), nowMs }), 'INVALID_EVENT_SIGNATURE');
  rejects(() => verified(body, signed(body).replace('1793527200', '1793527201')), 'INVALID_EVENT_SIGNATURE');
  for (const header of [undefined, [signed(body)], signed(body) + ',' + signed(body), 't=01,v1=' + '0'.repeat(64),
    signed(body).replace(/v1=.*/, 'v1=00'), signed(body).replace('t=', 'T='), signed(body) + '\n']) {
    rejects(() => verified(body, header), 'INVALID_EVENT_SIGNATURE');
  }
  // Correctly authenticated malformed/noncanonical inputs must still be refused.
  const event = verified(body, signed(body)).event;
  // Authentication alone cannot prove that the signed amount matches an
  // attempt in PostgreSQL. The future inbox must compare its saved tuple.
  const otherAmount = encodeSimulatedEvent({ ...event, amountMinor: 1 });
  assert.equal(verified(otherAmount, signed(otherAmount)).event.amountMinor, 1);
  const invalid = [Buffer.from('{'), Buffer.from('null'), Buffer.from(JSON.stringify([event])),
    Buffer.from(JSON.stringify({ ...event, amountMinor: '24690' })), Buffer.from(JSON.stringify({ ...event, paid: true })),
    Buffer.from(JSON.stringify({ ...event, paymentMode: 'live' })), Buffer.from(JSON.stringify({ ...event, amountMinor: 1e20 })),
    Buffer.from(JSON.stringify({ ...event, currency: 'inr' })), Buffer.from(JSON.stringify({ ...event, currency: 'INR\n' })),
    Buffer.from(JSON.stringify({ ...event, eventId: event.eventId + '\n' })),
    Buffer.from(JSON.stringify({ ...event, providerPaymentId: event.providerPaymentId + '\n' })),
    Buffer.from(JSON.stringify({ ...event, paymentAttemptId: event.paymentAttemptId + '\n' })),
    Buffer.from(JSON.stringify({ ...event, occurredAt: '2026-11-01T09:00:00Z' })),
    Buffer.from(body.toString().replace('"version":1', '"version":0,"version":1')),
    Buffer.from(body.toString() + '\n'), Buffer.concat([body, Buffer.from([0xff])]),
    Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(event).reverse())))];
  for (const value of invalid) rejects(() => verified(value, signed(value)), 'INVALID_EVENT_BODY');
  for (const value of [body.toString(), {}, Buffer.alloc(0), Buffer.alloc(MAX_SIMULATED_EVENT_BYTES + 1)]) {
    rejects(() => verified(value, signed(body)), 'INVALID_EVENT_BODY');
  }
  assert.throws(() => signSimulatedDelivery(body, { secret: 'short', nowMs }), TypeError);
  assert.throws(() => signSimulatedDelivery(body, { secret: secret + '\n', nowMs }), TypeError);
  assert.throws(() => verified(body, signed(body), NaN), TypeError);
  assert.throws(() => verified(body, signed(body), -1), TypeError);
  rejects(() => createSimulatedEvent({ ...receipt, providerPaymentId: 'sim_pay_' + '0'.repeat(64) }, duplicate[1]), 'INVALID_EVENT_SOURCE');
  rejects(() => createSimulatedEvent(receipt, { ...duplicate[1], occurredAfterMs: -1 }), 'INVALID_EVENT_SOURCE');
});
