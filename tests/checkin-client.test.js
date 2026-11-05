import test from 'node:test';
import assert from 'node:assert/strict';
import { checkinRequest, CheckinError } from '../apps/web/src/checkins/client.js';
import { createCheckinStore } from '../apps/web/src/checkins/store.js';
import { bookingReturnPath } from '../apps/web/src/reservations/model.js';

const id = n => '90000000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = { userId: id(1), organizationId: id(2), showId: id(3) }, key = id(4), ticket = id(5);
const credential = 'sl1.' + ticket + '.' + 'a'.repeat(43), csrfToken = 'b'.repeat(43);
const command = { ...scope, requestKey: key, ticketId: ticket };
const receipt = (fresh = false) => ({ status: fresh ? 'CHECKED_IN' : 'ALREADY_RECORDED', admissionGranted: fresh, paymentMode: 'simulated',
  checkin: { ticketId: ticket, showId: scope.showId, bookingItemId: id(6), requestKey: key, checkedAt: '2026-11-04T21:00:00.123456Z', section: 'Stalls', row: 'A', number: 1 } });
function memory() { const data = new Map(); return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; }
const flush = () => new Promise(resolve => setImmediate(resolve));

test('scan transport validates scope/freshness, sends private body and exact protected return paths', async () => {
  let sent;
  const result = await checkinRequest({ command, credential, csrfToken, fetchImpl: async (path, options) => {
    assert.equal(path.includes(credential), false); sent = options; return Response.json(receipt(true), { status: 201 });
  } });
  assert.equal(result.admissionGranted, true); assert.equal(sent.headers['X-CSRF-Token'], csrfToken);
  assert.equal(sent.credentials, 'same-origin'); assert.equal(sent.cache, 'no-store');
  assert.deepEqual(JSON.parse(sent.body), { credential, requestKey: key });
  const history = await checkinRequest({ command, recover: true, fetchImpl: async (path, options) => {
    assert.ok(path.endsWith('/' + key)); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); return Response.json(receipt());
  } }); assert.equal(history.admissionGranted, false);
  for (const data of [receipt(true), { ...receipt(), checkin: { ...receipt().checkin, showId: id(9) } }, { ...receipt(), credential }]) {
    await assert.rejects(checkinRequest({ command, recover: true, fetchImpl: async () => Response.json(data) }), e => e.code === 'UNKNOWN');
  }
  const path = `/organizers/${id(2)}/events/${id(8)}/shows/${id(3)}/check-in`;
  assert.equal(bookingReturnPath(path), path);
  for (const bad of ['https://example.invalid' + path, path + '?credential=x', path + '/extra', '//example.invalid' + path]) assert.equal(bookingReturnPath(bad), null);
});

test('unknown scan keeps original identity through missing receipt, reload and later rejection; retry never becomes fresh', async () => {
  const storage = memory(), calls = [];
  const first = createCheckinStore({ ...scope, csrfToken, storage: () => storage, uuid: () => key,
    request: async options => { calls.push(options); throw new CheckinError(); } });
  first.start(); await first.submit(credential); assert.equal(first.getSnapshot().stage, 'pending'); first.cancel();
  assert.equal([...storage.data.values()].some(v => v.includes(credential) || v.includes(csrfToken)), false);
  let attempts = 0;
  const resumed = createCheckinStore({ ...scope, csrfToken, storage: () => storage, uuid: () => { throw new Error('Must reuse key'); },
    request: async options => { calls.push(options);
      if (options.recover) throw new CheckinError('NOT_FOUND', 404);
      if (++attempts === 1) throw new CheckinError('CSRF_REJECTED', 403);
      return receipt();
    } });
  resumed.start(); await flush(); assert.equal(resumed.getSnapshot().pending.requestKey, key);
  await resumed.submit('sl1.' + id(99) + '.' + 'a'.repeat(43)); assert.equal(attempts, 0);
  await resumed.submit(credential); assert.equal(resumed.getSnapshot().pending.requestKey, key);
  await resumed.submit(credential); assert.equal(resumed.getSnapshot().receipt.admissionGranted, false);
  assert.equal(storage.data.size, 0); assert.ok(calls.every(call => call.command.requestKey === key)); resumed.cancel();
});

test('double click sends one write; an unmounted result cannot grant admission and recovery stays historical', async () => {
  const storage = memory(); let finish, writes = 0;
  const store = createCheckinStore({ ...scope, csrfToken, storage: () => storage, uuid: () => key,
    request: options => options.recover ? Promise.resolve(receipt()) : (writes++, new Promise(resolve => { finish = resolve; })) });
  store.start(); const pending = store.submit(credential); await store.submit(credential); assert.equal(writes, 1);
  store.cancel(); finish(receipt(true)); await pending; assert.equal(store.getSnapshot().receipt, null); assert.equal(storage.data.size, 1);
  store.start(); await flush(); assert.equal(store.getSnapshot().receipt.admissionGranted, false);
  assert.equal(writes, 1);
  store.next(); const hidden = store.submit(credential); store.leave(); finish(receipt(true)); await hidden;
  assert.equal(store.getSnapshot().receipt.admissionGranted, false, 'A response arriving after blur stays historical'); store.cancel();
});

test('storage failure blocks a write; fresh rejection can clear identity and leaving a new success removes its green grant', async () => {
  let writes = 0; const broken = memory(); broken.setItem = () => { throw new Error('private browser'); };
  const blocked = createCheckinStore({ ...scope, csrfToken, storage: () => broken, uuid: () => key, request: async () => { writes++; return receipt(true); } });
  blocked.start(); await blocked.submit(credential); assert.equal(writes, 0); assert.equal(blocked.getSnapshot().stage, 'blocked'); blocked.cancel();
  const storage = memory(); let reject = true;
  const store = createCheckinStore({ ...scope, csrfToken, storage: () => storage, uuid: () => key,
    request: async () => { if (reject) throw new CheckinError('TICKET_ALREADY_USED', 409); return receipt(true); } });
  store.start(); await store.submit(credential); assert.equal(store.getSnapshot().pending, null); assert.equal(storage.data.size, 0);
  reject = false; await store.submit(credential); assert.equal(store.getSnapshot().receipt.admissionGranted, true);
  store.leave(); assert.equal(store.getSnapshot().receipt.admissionGranted, false); store.next(); assert.equal(store.getSnapshot().stage, 'ready'); store.cancel();
});
