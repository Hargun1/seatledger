import test from 'node:test';
import assert from 'node:assert/strict';
import { readSearch, searchFor, seatingSections, priceLabel, instant, venueWhen } from '../apps/web/src/discovery/model.js';
import { discoveryRequest, DiscoveryError } from '../apps/web/src/discovery/client.js';
import { createPublicReader } from '../apps/web/src/discovery/reader.js';

const id = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const eventId = id(1), showId = id(2), sectionId = id(3);
const event = { id: eventId, title: 'Live at the Lantern', category: 'Music' };
const show = { id: showId, startsAt: '2027-02-20T13:30:00+00:00', venue: { id: id(4), name: 'Lantern Room', city: 'Bengaluru', timezone: 'Asia/Kolkata' } };
const seat = { id: id(5), sectionId, section: 'Stalls', row: 'A', number: 1, state: 'AVAILABLE', priceMinor: 45000, currency: 'INR' };
const map = { event, show, seats: [seat], asOf: '2026-10-31T01:02:03.123456Z', advisory: true, readOnly: true, paymentMode: 'simulated' };

test('discovery URLs, calendar/zone display and seat grouping preserve the API meaning', () => {
  const search = searchFor({ q: ' 50%_\\ ', city: ' Bengaluru ', from: '2028-02-29', to: '2028-03-01' }, id(8));
  assert.deepEqual(readSearch(search), { valid: true, filters: { q: '50%_\\', city: 'Bengaluru', from: '2028-02-29', to: '2028-03-01' }, cursor: id(8) });
  assert.equal(readSearch(searchFor({ q: 'Jazz' })).cursor, null);
  for (const bad of ['q=', 'city=A&city=B', 'from=2027-02-29', 'from=2028-03-01&to=2028-02-29', 'after=bad', 'limit=50']) assert.equal(readSearch(bad).valid, false);
  assert.equal(readSearch('q=Jazz', true).valid, false);
  assert.equal(instant(show.startsAt), true); assert.equal(instant('2027-02-30T12:00:00Z'), false);
  assert.equal(instant('2027-02-20T24:00:00Z'), false); assert.match(venueWhen(show), /7:00 pm/i);
  assert.match(priceLabel(45001, 'INR'), /450\.01/); assert.match(priceLabel(45001, 'JPY'), /45,001 minor units \(JPY\)/);
  const seats = [seat, { ...seat, id: id(6), number: 2, state: 'HELD' }, { ...seat, id: id(7), row: 'B', state: 'BOOKED' }];
  const grouped = seatingSections(seats); assert.deepEqual(grouped[0].rows.map(r => r.label), ['A', 'B']);
  assert.deepEqual(grouped.flatMap(s => s.rows.flatMap(r => r.cells)), seats);
});

test('public transport validates real identity, page progression, seat state/price and safe errors', async () => {
  const previous = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (path, options) => { calls++; assert.equal(path, `/api/events/${eventId}/shows/${showId}/seats`); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); return Response.json(map); };
    assert.equal((await discoveryRequest('seats', { eventId, showId })).seats[0].priceMinor, 45000);
    await assert.rejects(discoveryRequest('event', { eventId: 'bad' }), { status: 404 }); assert.equal(calls, 1);
    for (const bad of [{ ...map, event: { ...event, id: id(9) } }, { ...map, readOnly: false }, { ...map, seats: [seat, seat] },
      { ...map, seats: [{ ...seat, currency: ['INR'] }] }, { ...map, seats: [{ ...seat, state: '__proto__' }] },
      { ...map, seats: [{ ...seat, priceMinor: -1 }] }, { ...map, show: { ...show, venue: { ...show.venue, timezone: 'invalid' } } }]) {
      globalThis.fetch = async () => Response.json(bad); await assert.rejects(discoveryRequest('seats', { eventId, showId }), { code: 'INVALID_RESPONSE' });
    }
    globalThis.fetch = async () => Response.json({ items: [{ ...event, nextShow: show }], nextCursor: eventId, paymentMode: 'simulated' });
    await assert.rejects(discoveryRequest('events', { search: 'after=' + eventId }), { code: 'INVALID_RESPONSE' });
    globalThis.fetch = async () => Response.json({ error: '__proto__', secret: 'private-value' }, { status: 500 });
    await assert.rejects(discoveryRequest('events'), error => error instanceof DiscoveryError && !error.message.includes('private-value') && error.code === 'UNKNOWN');
  } finally { globalThis.fetch = previous; }
});

test('public reads clear stale success and ignore abandoned or late requests without replay', async () => {
  const pending = [], reader = createPublicReader(signal => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })));
  const first = reader.refresh(), second = reader.refresh(); assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ eventId: 'new' }); await second; pending[0].resolve({ eventId: 'old' }); await first;
  assert.equal(reader.getSnapshot().data.eventId, 'new');
  const refresh = reader.refresh(); assert.deepEqual(reader.getSnapshot(), { status: 'loading', data: null, error: null });
  pending[2].reject(new DiscoveryError('CATALOG_UNAVAILABLE', 503)); await refresh;
  assert.equal(reader.getSnapshot().status, 'error'); assert.equal(reader.getSnapshot().data, null); assert.equal(pending.length, 3);
  const abandoned = reader.refresh(); reader.cancel(); pending[3].resolve({ eventId: 'abandoned' }); await abandoned;
  assert.notEqual(reader.getSnapshot().status, 'ready');
  const remount = reader.refresh(); pending[4].resolve(map); await remount; assert.equal(reader.getSnapshot().status, 'ready');
});
