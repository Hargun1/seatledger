import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingReturnPath, validAgreement, remainingLabel } from '../apps/web/src/reservations/model.js';
import { BookingError, reservationRequest, readAllCurrent } from '../apps/web/src/reservations/client.js';
import { createRequestJournal } from '../apps/web/src/reservations/journal.js';
import { createBookingStore } from '../apps/web/src/reservations/store.js';

const id = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userId = id(1), showId = id(2), eventId = id(3), csrfToken = 'a'.repeat(43);
const asOf = '2026-11-01T10:00:00.000000Z';
const agreement = (n = 40, seatIds = [id(10)]) => ({ id: id(n), showId, status: 'ACTIVE', effectiveStatus: 'ACTIVE',
  createdAt: asOf, expiresAt: '2026-11-01T10:05:00.000000Z', currency: 'INR', totalMinor: 12500 * seatIds.length,
  items: [...seatIds].sort().map(id => ({ id, priceMinor: 12500, currency: 'INR' })), paymentMode: 'simulated' });
const command = { kind: 'create', userId, showId, key: 'saved-key', seatIds: [id(10)] };
function memory() { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k), values }; }
function fixture(overrides = {}) {
  const storage = memory(), journal = createRequestJournal(userId, showId, () => storage), calls = [];
  const map = { seats: Array.from({ length: 10 }, (_, i) => ({ id: id(i + 10), state: i === 9 ? 'HELD' : 'AVAILABLE', priceMinor: 12500, currency: 'INR' })) };
  const store = createBookingStore({ userId, showId, eventId, journal, getCsrf: () => csrfToken, newKey: () => 'new-key', clock: () => 0,
    loadMap: async () => map, recover: async () => ({ asOf, reservations: [] }), api: async (action, options) => { calls.push([action, options]); return agreement(); }, ...overrides });
  return { store, storage, journal, calls, map };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('booking models and tab journal preserve scoped intent, validate agreements and never accept open redirects', () => {
  const path = `/events/${eventId}/shows/${showId}/reserve`;
  assert.equal(bookingReturnPath(path.toUpperCase().replace('/EVENTS/', '/events/').replace('/SHOWS/', '/shows/').replace('/RESERVE', '/reserve')), path);
  for (const value of ['https://evil.invalid', '//evil.invalid', path + '?next=evil', path + '/..', '/account']) assert.equal(bookingReturnPath(value), null);
  assert.equal(validAgreement(agreement(), showId), true);
  for (const value of [{ ...agreement(), totalMinor: 1 }, { ...agreement(), items: [null] }, { ...agreement(), paymentMode: 'real' }]) assert.equal(validAgreement(value, showId), false);
  assert.equal(remainingLabel(agreement().expiresAt, asOf, 0, 1200), '4:58');
  assert.equal(remainingLabel(agreement().expiresAt, asOf, 0, 400000), 'Check expiry');
  const storage = memory(), journal = createRequestJournal(userId, showId, () => storage); journal.save(command);
  assert.deepEqual(journal.read(), command); assert.equal(createRequestJournal(id(99), showId, () => storage).read(), null);
  assert.ok(![...storage.values.values()][0].includes(csrfToken));
  assert.throws(() => journal.save({ ...command, csrfToken }), BookingError);
  storage.setItem([...storage.values.keys()][0], '{bad'); assert.throws(() => journal.read(), BookingError);
});

test('booking transport validates saved identity/prices, paginates fully and classifies safe rejection versus uncertainty', async () => {
  let sent;
  const fetchImpl = async (path, options) => { sent = { path, options }; return Response.json(agreement(), { status: 201 }); };
  assert.deepEqual(await reservationRequest('create', { userId, showId, command, csrfToken, fetchImpl }), agreement());
  assert.equal(sent.path, '/api/reservations'); assert.equal(sent.options.credentials, 'same-origin'); assert.equal(sent.options.cache, 'no-store');
  assert.equal(sent.options.headers['Idempotency-Key'], command.key); assert.equal(sent.options.headers['X-CSRF-Token'], csrfToken);
  assert.deepEqual(JSON.parse(sent.options.body), { showId, seatIds: command.seatIds });
  const rows = Array.from({ length: 22 }, (_, i) => agreement(i + 100)); let pages = 0;
  const pageFetch = async (path, options) => { assert.equal(options.method, 'GET'); pages++; const after = new URL(path, 'http://local').searchParams.get('after');
    const current = after ? rows.slice(20) : rows.slice(0, 20); return Response.json({ showId, asOf, reservations: current, readOnly: true, paymentMode: 'simulated', nextCursor: after ? null : current.at(-1).id }); };
  assert.deepEqual((await readAllCurrent({ userId, showId, fetchImpl: pageFetch })).reservations, rows); assert.equal(pages, 2);
  await assert.rejects(reservationRequest('create', { userId, showId, command, csrfToken, fetchImpl: async () => Response.json({ error: 'SEATS_UNAVAILABLE', unavailableSeatIds: command.seatIds }, { status: 409 }) }), e => e.code === 'SEATS_UNAVAILABLE' && !e.uncertain);
  for (const fetchImpl of [async () => { throw new Error('private connection details'); }, async () => Response.json({ ...agreement(), items: [null] }, { status: 201 }), async () => Response.json({ error: 'raw database password' }, { status: 500 })]) {
    await assert.rejects(reservationRequest('create', { userId, showId, command, csrfToken, fetchImpl }), e => e instanceof BookingError && e.uncertain && !e.message.includes('password') && !e.message.includes('private'));
  }
  await assert.rejects(reservationRequest('current', { userId, showId, fetchImpl: async () => Response.json(null) }), BookingError);
  await assert.rejects(reservationRequest('release', { userId, showId, csrfToken, command: { kind: 'release', userId, showId, key: 'release-key', reservationId: agreement().id },
    fetchImpl: async () => Response.json(agreement()) }), e => e.uncertain);
});

test('selection is bounded; double click and lost response reuse one durable command; replay cannot fake a renewed hold', async () => {
  const waiting = deferred(), calls = [];
  const f = fixture({ api: async (action, options) => { calls.push(options.command); if (calls.length === 1) return waiting.promise; return agreement(); } });
  await f.store.refresh(); for (let n = 10; n <= 18; n++) f.store.select(id(n));
  assert.equal(f.store.getSnapshot().selected.length, 8); f.store.select(id(19)); assert.equal(f.store.getSnapshot().selected.length, 8);
  for (let n = 11; n <= 17; n++) f.store.select(id(n)); assert.deepEqual(f.store.getSnapshot().selected, [id(10)]);
  f.store.select(id(19)); assert.deepEqual(f.store.getSnapshot().selected, [id(10), id(19)], 'A coarse HELD cell is an advisory request, not an expiry decision'); f.store.select(id(19));
  const sending = f.store.hold(); await f.store.hold(); assert.equal(calls.length, 1); assert.deepEqual(f.journal.read(), calls[0]);
  waiting.reject(new BookingError('CONNECTION_ERROR', 0, { uncertain: true })); await sending;
  assert.equal(f.store.getSnapshot().requestState, 'uncertain'); f.store.select(id(11)); assert.deepEqual(f.store.getSnapshot().selected, [id(10)]);
  await f.store.refresh(); assert.deepEqual(f.store.getSnapshot().holds, []); assert.ok(f.store.getSnapshot().pending);
  await f.store.retry(); assert.deepEqual(calls[1], calls[0]); assert.equal(f.journal.read(), null);
  assert.equal(f.store.getSnapshot().pending, null); assert.deepEqual(f.store.getSnapshot().holds, [], 'Historical ACK never becomes a fabricated current hold');
});

test('refresh/cancel fence late reads and writes; a restored release keeps its original identity', async () => {
  const oldRead = deferred(), freshRead = deferred(), write = deferred(); let reads = 0;
  const f = fixture({ recover: () => (++reads === 1 ? oldRead.promise : freshRead.promise), api: () => write.promise });
  const first = f.store.refresh(), second = f.store.refresh(); freshRead.resolve({ asOf, reservations: [agreement()] }); await second;
  oldRead.resolve({ asOf, reservations: [] }); await first; assert.equal(f.store.getSnapshot().holds.length, 1);
  const pending = f.store.release(agreement().id); const saved = f.journal.read(); assert.equal(saved.kind, 'release');
  f.store.cancel(); write.resolve({ ...agreement(), status: 'RELEASED', effectiveStatus: 'RELEASED' }); await pending;
  assert.deepEqual(f.journal.read(), saved, 'Unmount is not proof that the server rolled back');
  const restored = createBookingStore({ userId, showId, eventId, journal: f.journal, getCsrf: () => csrfToken });
  assert.deepEqual(restored.getSnapshot().pending, saved); assert.equal(restored.getSnapshot().requestState, 'uncertain');
});

test('storage failure prevents sending; known first rejection clears intent but rejection after uncertainty retains it', async () => {
  const f = fixture({ journal: { read: () => null, save() { throw new BookingError('STORAGE_UNAVAILABLE'); } } });
  await f.store.refresh(); f.store.select(id(10)); await f.store.hold(); assert.equal(f.calls.length, 0); assert.equal(f.store.getSnapshot().storageError, true);
  let failUncertain = false;
  const reject = async () => { throw new BookingError(failUncertain ? 'CONNECTION_ERROR' : 'SEATS_UNAVAILABLE', 409, { uncertain: failUncertain }); };
  const fresh = fixture({ api: reject }); await fresh.store.refresh(); fresh.store.select(id(10)); await fresh.store.hold();
  assert.equal(fresh.journal.read(), null); assert.equal(fresh.store.getSnapshot().pending, null);
  failUncertain = true; fresh.store.select(id(10)); await fresh.store.hold(); failUncertain = false; await fresh.store.retry();
  assert.ok(fresh.journal.read()); assert.equal(fresh.store.getSnapshot().requestState, 'uncertain');
  let clearFails = true; const saved = memory(), real = createRequestJournal(userId, showId, () => saved);
  const clearing = fixture({ journal: { ...real, clear() { if (clearFails) throw new BookingError('STORAGE_UNAVAILABLE'); real.clear(); } } });
  await clearing.store.refresh(); clearing.store.select(id(10)); await clearing.store.hold();
  assert.ok(real.read()); assert.equal(clearing.store.getSnapshot().storageError, true);
  clearFails = false; await clearing.store.retry(); assert.equal(real.read(), null); assert.equal(clearing.calls.length, 2);
  assert.deepEqual(clearing.calls[0][1].command, clearing.calls[1][1].command);
});

test('durable resolution validates its receipt, keeps the original command and reads existing success without releasing it', async () => {
  const receipt = { error: 'REQUEST_CLOSED', operation: 'reservation.create', requestKey: command.key, paymentMode: 'simulated' };
  let sent;
  const result = await reservationRequest('resolve', { userId, showId, command, csrfToken, fetchImpl: async (path, options) => {
    sent = { path, options }; return Response.json(receipt, { status: 409 });
  } });
  assert.deepEqual(result, receipt); assert.equal(sent.path, '/api/reservations/resolve-create');
  assert.equal(sent.options.headers['Idempotency-Key'], command.key); assert.deepEqual(JSON.parse(sent.options.body), { showId, seatIds: command.seatIds });
  await assert.rejects(reservationRequest('resolve', { userId, showId, command, csrfToken,
    fetchImpl: async () => Response.json({ ...receipt, requestKey: 'wrong-key' }, { status: 409 }) }), e => e.uncertain);
  for (const completed of [false, true]) {
    let settled = false;
    const calls = [], f = fixture({ api: async (action, options) => {
      calls.push([action, options.command]);
      if (action === 'create') throw new BookingError('CONNECTION_ERROR', 0, { uncertain: true });
      settled = true;
      return completed ? agreement() : { ...receipt, requestKey: options.command.key };
    }, recover: async () => ({ asOf, reservations: completed && settled ? [agreement()] : [] }) });
    await f.store.refresh(); f.store.select(id(10)); await f.store.hold(); const original = f.journal.read();
    await f.store.resolve(); assert.equal(calls[1][0], 'resolve'); assert.deepEqual(calls[1][1], original);
    assert.equal(f.journal.read(), null); assert.equal(f.store.getSnapshot().pending, null);
    assert.equal(f.store.getSnapshot().holds.length, completed ? 1 : 0);
    assert.equal(calls.some(([action]) => action === 'release'), false);
  }
});
