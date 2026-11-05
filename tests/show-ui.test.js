import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWallTime, wallMinute, minuteInstant, priceInPaise, priceInput, showPayload } from '../apps/web/src/shows/model.js';
import { showRequest, settleInScope } from '../apps/web/src/shows/client.js';
import { showInput, showPatch } from '../apps/api/src/shows/policy.js';

const org = '10000000-0000-4000-8000-000000000001', eventId = '20000000-0000-4000-8000-000000000001', id = '30000000-0000-4000-8000-000000000001', venueId = '40000000-0000-4000-8000-000000000001';
const venue = { id: venueId, revision: 3, timezone: 'Asia/Kolkata' }, organization = { id: org, name: 'Team', role: 'OWNER', status: 'APPROVED' }, event = { id: eventId, title: 'Talk', category: 'Talks', status: 'DRAFT' };
const saved = { id, eventId, venueId, status: 'SCHEDULED', startsAt: '2030-10-30T13:30:00.123Z', priceMinor: 75000, currency: 'INR', revision: 4 };
test('a committed write completing after scope disposal cannot trigger success navigation', async () => {
  let finish, current = true, navigations = 0;
  const delayed = new Promise(resolve => { finish = resolve; });
  const pending = settleInScope(() => delayed, () => current).then(() => { navigations++; });
  current = false; finish({ id }); await assert.rejects(pending, /confirm/); assert.equal(navigations, 0);
  await settleInScope(async () => ({ id }), () => true).then(() => { navigations++; }); assert.equal(navigations, 1);
});
test('venue wall time resolves without using the device zone, including quarter-hour offsets', () => {
  assert.deepEqual(resolveWallTime('2030-10-30T19:00', 'Asia/Kolkata'), { candidates: ['2030-10-30T13:30:00.000Z'] });
  assert.deepEqual(resolveWallTime('2030-10-30T19:00', 'Asia/Kathmandu'), { candidates: ['2030-10-30T13:15:00.000Z'] });
  assert.equal(wallMinute('2030-10-30T13:30:00.123Z', 'Asia/Kolkata'), '2030-10-30T19:00');
  for (const value of ['', '2030-02-30T19:00', '2030-00-01T19:00', '2030-01-00T19:00', '2030-01-01T24:00', '1999-01-01T00:00', '2101-01-01T00:00']) assert.ok(resolveWallTime(value, 'UTC').error);
  assert.ok(resolveWallTime('2030-01-01T00:00', 'Unknown/Zone').error);
});
test('DST gaps reject and repeated venue times return every minute-aligned candidate', () => {
  assert.ok(resolveWallTime('2030-03-10T02:30', 'America/New_York').error);
  assert.deepEqual(resolveWallTime('2030-11-03T01:30', 'America/New_York').candidates, ['2030-11-03T05:30:00.000Z', '2030-11-03T06:30:00.000Z']);
  assert.deepEqual(resolveWallTime('2030-04-07T01:45', 'Australia/Lord_Howe').candidates, ['2030-04-06T14:45:00.000Z', '2030-04-06T15:15:00.000Z']);
});
test('rupee strings become exact bounded integer paise without float price arithmetic', () => {
  for (const [input, expected] of [['0', 0], ['0.01', 1], ['750.25', 75025], ['001.20', 120], ['1000000.00', 100000000]]) assert.equal(priceInPaise(input), expected);
  for (const input of ['', '-1', '1.001', '1e2', '1,000', '1000000.01', 'Infinity', '.50']) assert.equal(priceInPaise(input), null);
  assert.equal(priceInput(75001), '750.01'); assert.equal(priceInput(null), '');
});
test('create/edit payloads match API grammar; unchanged time is omitted and imported precision is preserved', () => {
  const created = showPayload({ localTime: '2030-10-30T19:00', occurrence: '', price: '750.25' }, venue);
  assert.equal(showInput.safeParse(created.body).success, true); assert.equal(created.body.expectedVenueRevision, 3); assert.equal(created.body.priceMinor, 75025);
  const changed = showPayload({ localTime: '2030-10-30T19:00', occurrence: minuteInstant(saved.startsAt), price: '800' }, venue, saved);
  assert.deepEqual(changed.body, { expectedRevision: 4, priceMinor: 80000 }); assert.equal(showPatch.safeParse(changed.body).success, true);
  assert.equal(showPayload({ localTime: '2030-10-30T19:00', occurrence: minuteInstant(saved.startsAt), price: '750' }, venue, saved).unchanged, true);
  const ny = { ...venue, timezone: 'America/New_York' }, fields = { localTime: '2030-11-03T01:30', occurrence: '', price: '0' };
  assert.ok(showPayload(fields, ny).errors.occurrence);
  assert.equal(showPayload({ ...fields, occurrence: '2030-11-03T06:30:00.000Z' }, ny).body.startsAt, '2030-11-03T06:30:00.000Z');
});
test('show reads are scoped, bounded and reject missing use hints or mismatched event/role', async () => {
  const previous = globalThis.fetch, options = { organizationId: org, eventId, showId: id };
  let calls = 0;
  try {
    for (const action of ['__proto__', 'constructor', 'unknown']) await assert.rejects(showRequest(action, options), { status: 400 });
    globalThis.fetch = async () => { calls++; return Response.json({ ...saved, inUse: false, organization, event }); };
    assert.equal((await showRequest('detail', options)).inUse, false); assert.equal(calls, 1);
    for (const bad of [{ ...saved, organization, event }, { ...saved, inUse: false, organization, event: { ...event, id: venueId } }, { ...saved, inUse: false, organization: { ...organization, role: 'ADMIN' }, event }]) {
      globalThis.fetch = async () => Response.json(bad); await assert.rejects(showRequest('detail', options), /confirm/);
    }
    globalThis.fetch = async () => Response.json({ items: [saved, saved], organization, event, nextCursor: null }); await assert.rejects(showRequest('list', options), /confirm/);
    await assert.rejects(showRequest('detail', { ...options, eventId: 'invalid' }), { status: 404 });
  } finally { globalThis.fetch = previous; }
});
test('show mutations send cookie/CSRF/revision boundaries and validate saved identities and prices', async () => {
  const previous = globalThis.fetch, options = { organizationId: org, eventId, showId: id, venueId, csrfToken: 'fixture-csrf', body: { expectedRevision: 4, priceMinor: 80000 } }; let sent;
  try {
    globalThis.fetch = async (url, init) => { sent = { url, init }; return Response.json({ ...saved, priceMinor: 80000, revision: 5 }); };
    await showRequest('patch', options); assert.equal(sent.init.method, 'PATCH'); assert.equal(sent.init.credentials, 'same-origin'); assert.equal(sent.init.headers['X-CSRF-Token'], 'fixture-csrf'); assert.equal(JSON.parse(sent.init.body).expectedRevision, 4);
    for (const bad of [{ ...saved, priceMinor: 75000, revision: 5 }, { ...saved, priceMinor: 80000, revision: 6 }, { ...saved, venueId: id, priceMinor: 80000, revision: 5 }]) { globalThis.fetch = async () => Response.json(bad); await assert.rejects(showRequest('patch', options), /confirm/); }
    for (const error of ['__proto__', 'constructor', { secret: 'never reflect' }, 'credentials in raw response']) { globalThis.fetch = async () => Response.json({ error }, { status: 500 }); await assert.rejects(showRequest('patch', options), e => typeof e.message === 'string' && !e.message.includes('secret') && !e.message.includes('credentials')); }
    globalThis.fetch = async () => { throw new Error('network private data'); }; await assert.rejects(showRequest('patch', options), /reach/);
  } finally { globalThis.fetch = previous; }
});
