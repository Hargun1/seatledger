import test from 'node:test';
import assert from 'node:assert/strict';
import { readCustomerRefund, validRefundStatus, refundOutcome } from '../apps/web/src/payments/refund.js';

const payment = { id: '70000000-0000-4000-8000-000000000001', amountMinor: 75000, currency: 'INR' };
const refund = { id: '70000000-0000-4000-8000-000000000002', amountMinor: 75000, currency: 'INR',
  status: 'REQUESTED', reason: 'INVENTORY_LOST', progress: 'QUEUED', requestedAt: '2026-11-05T10:00:00.123456Z', completedAt: null };
const body = patch => ({ paymentId: payment.id, paymentMode: 'simulated', refund: { ...refund, ...patch } });

test('refund read binds payment amount, currency, exact times and completed evidence; review never implies success', () => {
  assert.equal(validRefundStatus(body(), payment), true);
  assert.equal(validRefundStatus({ ...body(), refund: null }, payment), true);
  assert.match(refundOutcome({ refund: null }).detail, /does not confirm completion/);
  for (const patch of [{ amountMinor: 1 }, { currency: 'USD' }, { status: 'SUCCEEDED' }, { progress: 'COMPLETED' },
    { completedAt: refund.requestedAt }, { reason: 'secret error' }, { progress: 'UNKNOWN' }, { requestedAt: '2026-11-05T10:00:00+01:00' }])
    assert.equal(validRefundStatus(body(patch), payment), false);
  for (const progress of ['QUEUED','PROCESSING','RETRYING','REVIEW_REQUIRED']) {
    assert.equal(validRefundStatus(body({ progress }), payment), true);
    assert.doesNotMatch(refundOutcome(body({ progress })).title, /completed/);
  }
  const done = body({ status: 'SUCCEEDED', progress: 'COMPLETED', completedAt: '2026-11-05T10:00:00.123457Z' });
  assert.equal(validRefundStatus(done, payment), true); assert.match(refundOutcome(done).title, /completed/);
  assert.equal(validRefundStatus({ ...done, paymentId: refund.id }, payment), false);
  assert.equal(validRefundStatus(body({ status: 'SUCCEEDED', progress: 'COMPLETED', completedAt: '2026-11-05T10:00:00.123455Z' }), payment), false);
  assert.equal(validRefundStatus({ ...done, paymentMode: 'real' }, payment), false);
});

test('refund transport only GETs with private caching, forwards abort and sanitizes invalid/foreign/error replies', async () => {
  let sent; const signal = new AbortController().signal;
  const value = await readCustomerRefund({ payment, signal, fetchImpl: async (path, options) => { sent = { path, options }; return Response.json(body()); } });
  assert.equal(value.refund.progress, 'QUEUED'); assert.equal(sent.path, `/api/payments/${payment.id}/refund`);
  assert.equal(sent.options.method, 'GET'); assert.equal(sent.options.credentials, 'same-origin'); assert.equal(sent.options.cache, 'no-store');
  assert.equal(sent.options.body, undefined); assert.equal(sent.options.headers, undefined); assert.ok(sent.options.signal);
  for (const data of [{ ...body(), paymentId: refund.id }, body({ amountMinor: 2 }), body({ status: 'SUCCEEDED' })])
    await assert.rejects(readCustomerRefund({ payment, fetchImpl: async () => Response.json(data) }), e => e.code === 'INVALID_RESPONSE');
  await assert.rejects(readCustomerRefund({ payment, fetchImpl: async () => Response.json({ error: 'private driver details' }, { status: 500 }) }), e => !e.message.includes('private') && e.status === 500);
  await assert.rejects(readCustomerRefund({ payment, fetchImpl: async () => Response.json({ error: 'NOT_FOUND' }, { status: 404 }) }), e => e.status === 404);
});
