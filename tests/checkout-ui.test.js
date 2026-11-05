import test from 'node:test';
import assert from 'node:assert/strict';
import { validPayment, paymentOutcome } from '../apps/web/src/payments/model.js';
import { checkoutRequest, readPaymentHistory, CheckoutError } from '../apps/web/src/payments/client.js';
import { createPaymentJournal } from '../apps/web/src/payments/journal.js';
import { createCheckoutStore } from '../apps/web/src/payments/store.js';
import { bookingReturnPath } from '../apps/web/src/reservations/model.js';

const id = n => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userId = id(1), showId = id(2), reservationId = id(3), eventId = id(4), csrfToken = 'a'.repeat(43);
const scope = { userId, showId, reservationId }, command = { ...scope, key: 'original-payment-key' };
const agreement = { id: reservationId, showId, status: 'ACTIVE', effectiveStatus: 'ACTIVE', createdAt: '2026-11-04T10:00:00.000000Z',
  expiresAt: '2026-11-04T10:05:00.000000Z', totalMinor: 12500, currency: 'INR', items: [{ id: id(10), priceMinor: 12500, currency: 'INR' }], paymentMode: 'simulated' };
const payment = (patch = {}) => ({ id: id(20), reservationId, showId, status: 'CREATED', resolution: 'UNRESOLVED', amountMinor: 12500,
  currency: 'INR', bookingId: null, createdAt: agreement.createdAt, paymentMode: 'simulated', ...patch });
function memory() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; }
function fixture(options = {}) {
  const storage = memory(), journal = createPaymentJournal(userId, showId, reservationId, () => storage), calls = [];
  const store = createCheckoutStore({ ...scope, journal, getCsrf: () => csrfToken, newKey: () => command.key,
    api: async (action, args) => { calls.push([action, args]); return action === 'agreement' ? agreement : payment(); }, history: async () => [], ...options });
  return { store, journal, storage, calls };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('checkout evidence binds saved amounts and scope; journal contains only identity; return paths stay local', () => {
  assert.equal(validPayment(payment(), { ...scope, agreement }), true);
  for (const patch of [{ amountMinor: 1 }, { currency: 'USD' }, { showId: id(99) }, { status: 'SUCCEEDED' }, { resolution: 'BOOKED' }, { paymentMode: 'real' }])
    assert.equal(validPayment(payment(patch), { ...scope, agreement }), false);
  assert.equal(paymentOutcome(payment({ status: 'SUCCEEDED', resolution: 'REFUND_REQUIRED' })).title, 'Refund requested.');
  assert.match(paymentOutcome(payment({ status: 'FAILED' })).detail, /delayed success/);
  const path = `/events/${eventId}/shows/${showId}/checkout/${reservationId}`;
  assert.equal(bookingReturnPath(path), path);
  for (const value of [path + '?next=evil', path + '/..', path.replace(reservationId, 'bad'), '//evil.invalid']) assert.equal(bookingReturnPath(value), null);
  const { journal, storage } = fixture(); journal.save(command); assert.deepEqual(journal.read(), command);
  assert.equal(createPaymentJournal(id(99), showId, reservationId, () => storage).read(), null);
  assert.equal(createPaymentJournal(userId, showId, id(99), () => storage).read(), null);
  for (const extra of [{ csrfToken }, { amountMinor: 1 }, { status: 'SUCCEEDED' }]) assert.throws(() => journal.save({ ...command, ...extra }), CheckoutError);
  storage.setItem([...storage.values.keys()][0], '{broken'); assert.throws(() => journal.read(), CheckoutError);
});

test('checkout transport sends empty keyed CSRF requests and refuses forged outcomes, pages and unsafe errors', async () => {
  let sent; const fetchImpl = async (path, options) => { sent = { path, options }; return Response.json(payment(), { status: 201 }); };
  const options = { ...scope, command, csrfToken, agreement, fetchImpl };
  await checkoutRequest('start', options); assert.equal(sent.path, `/api/reservations/${reservationId}/payment-attempts`);
  assert.equal(sent.options.body, '{}'); assert.equal(sent.options.headers['Idempotency-Key'], command.key); assert.equal(sent.options.headers['X-CSRF-Token'], csrfToken);
  assert.equal(sent.options.credentials, 'same-origin'); assert.equal(sent.options.cache, 'no-store');
  for (const patch of [{ amountMinor: 1 }, { bookingId: id(90) }, { status: 'SUCCEEDED', resolution: 'BOOKED', bookingId: null }])
    await assert.rejects(checkoutRequest('start', { ...options, fetchImpl: async () => Response.json(payment(patch), { status: 201 }) }), e => e.code === 'INVALID_RESPONSE' && e.uncertain);
  await assert.rejects(checkoutRequest('start', { ...options, fetchImpl: async () => Response.json({ error: '<secret driver payload>' }, { status: 500 }) }), e => e.uncertain && !e.message.includes('secret'));
  await assert.rejects(checkoutRequest('resolve', { ...options, fetchImpl: async () => Response.json({ error: 'REQUEST_CLOSED', operation: 'payment.create', requestKey: 'other', paymentMode: 'simulated' }, { status: 409 }) }), e => e.uncertain);
  const rows = Array.from({ length: 21 }, (_, n) => payment({ id: id(n + 30) })); let pages = 0;
  const result = await readPaymentHistory({ ...scope, agreement, fetchImpl: async () => { pages++; return Response.json({ reservationId, paymentMode: 'simulated', items: pages === 1 ? rows.slice(0, 20) : rows.slice(20), nextCursor: pages === 1 ? rows[19].id : null }); } });
  assert.equal(result.length, 21); assert.equal(pages, 2);
  await assert.rejects(checkoutRequest('history', { ...scope, agreement, fetchImpl: async () => Response.json({ reservationId, paymentMode: 'simulated', items: [payment({ reservationId: id(99) })], nextCursor: null }) }), CheckoutError);
});

test('double clicks and lost acknowledgements keep one durable key; empty reads and later rejections cannot clear uncertainty', async () => {
  const request = deferred(); let writes = 0, recovered = false;
  const f = fixture({ api: async action => { if (action === 'agreement') return agreement; writes++; if (writes === 1) return request.promise; throw new CheckoutError('RESERVATION_NOT_PAYABLE', 409); } });
  await f.store.refresh(); const first = f.store.start(); await f.store.start(); assert.equal(writes, 1); assert.deepEqual(f.journal.read(), command);
  request.reject(new CheckoutError('CONNECTION_ERROR', 0, true)); await first;
  await f.store.refresh(); assert.equal(f.store.getSnapshot().payments.length, 0); assert.deepEqual(f.journal.read(), command);
  await f.store.retry(); assert.equal(writes, 2); assert.ok(f.store.getSnapshot().pending); assert.equal(f.store.getSnapshot().requestState, 'uncertain');
  const restored = createCheckoutStore({ ...scope, journal: f.journal, getCsrf: () => csrfToken, api: async action => action === 'agreement' ? agreement : (recovered = true, { error: 'REQUEST_CLOSED' }), history: async () => [] });
  await restored.start(); assert.equal(recovered, false); await restored.resolve(); assert.equal(recovered, true); assert.equal(f.journal.read(), null);
});

test('POST replay triggers a current read; saved success cannot fake booking and existing failed attempts never rebill', async () => {
  let records = [], writes = 0;
  const f = fixture({ api: async action => { if (action === 'agreement') return agreement; writes++; records = [payment({ status: 'SUCCEEDED', resolution: 'BOOKED', bookingId: id(80) })]; return payment(); }, history: async () => records });
  await f.store.refresh(); await f.store.start(); assert.equal(f.store.getSnapshot().payments[0].resolution, 'BOOKED'); assert.equal(f.journal.read(), null);
  await f.store.start(); assert.equal(writes, 1);
  records = [payment({ status: 'FAILED' })]; await f.store.refresh(); await f.store.start(); assert.equal(writes, 1);
  const closed = fixture({ api: async () => ({ ...agreement, status: 'ACTIVE', effectiveStatus: 'EXPIRED' }) }); await closed.store.refresh(); await closed.store.start(); assert.equal(closed.journal.read(), null);
});

test('late reads and writes cannot repaint after refresh/cancel, while an aborted mutation keeps durable intent', async () => {
  const old = deferred(), fresh = deferred(), write = deferred(); let reads = 0;
  const f = fixture({ api: async action => action === 'agreement' ? (++reads === 1 ? old.promise : fresh.promise) : write.promise });
  const a = f.store.refresh(), b = f.store.refresh(); fresh.resolve(agreement); await b;
  old.resolve({ ...agreement, effectiveStatus: 'EXPIRED' }); await a; assert.equal(f.store.getSnapshot().agreement.effectiveStatus, 'ACTIVE');
  const pending = f.store.start(); f.store.cancel(); write.resolve(payment()); await pending;
  assert.deepEqual(f.journal.read(), command); assert.equal(f.store.getSnapshot().requestState, 'uncertain');
  assert.equal(f.store.getSnapshot().notice, '');
});

test('storage failures prevent new sends and preserve the key when acknowledgement cleanup fails', async () => {
  const blocked = fixture({ journal: { read: () => null, save() { throw new CheckoutError('STORAGE_UNAVAILABLE'); } } });
  await blocked.store.refresh(); await blocked.store.start(); assert.equal(blocked.calls.filter(([a]) => a === 'start').length, 0);
  assert.equal(blocked.store.getSnapshot().storageError, true);
  const storage = memory(), real = createPaymentJournal(userId, showId, reservationId, () => storage); let fail = true;
  const f = fixture({ journal: { ...real, clear() { if (fail) throw new CheckoutError('STORAGE_UNAVAILABLE'); real.clear(); } } });
  await f.store.refresh(); await f.store.start(); assert.deepEqual(real.read(), command); assert.equal(f.store.getSnapshot().storageError, true);
  fail = false; await f.store.retry(); assert.equal(real.read(), null); assert.equal(f.store.getSnapshot().pending, null);
});
