import test from 'node:test';
import assert from 'node:assert/strict';
import { showInput, showPatch, showDelete } from '../apps/api/src/shows/policy.js';
import { parseInput } from '../apps/api/src/organizers/policy.js';

const valid = { venueId: '10000000-0000-4000-8000-000000000001', expectedVenueRevision: 0, startsAt: '2030-10-30T18:00:00Z', priceMinor: 75000, currency: 'INR' };
test('show scheduling accepts explicit UTC instants and integer minor-unit INR prices only', () => {
  assert.deepEqual(parseInput(showInput, valid), valid);
  for (const time of ['2030-10-30T18:00:00.1Z', '2030-10-30T18:00:00.123Z']) assert.ok(showInput.safeParse({ ...valid, startsAt: time }).success);
  for (const startsAt of ['2030-10-30', '2030-10-30T18:00:00', '2030-10-30T18:00:00+05:30', '2030-02-30T18:00:00Z', '2030-10-30T18:00:00.1234Z', '0000-10-30T18:00:00Z']) assert.equal(showInput.safeParse({ ...valid, startsAt }).success, false);
  for (const priceMinor of [-1, 0.5, '75000', 100000001, Infinity, NaN]) assert.equal(showInput.safeParse({ ...valid, priceMinor }).success, false);
  assert.ok(showInput.safeParse({ ...valid, priceMinor: 0 }).success);
  assert.ok(showInput.safeParse({ ...valid, priceMinor: 100000000 }).success);
  assert.equal(showInput.safeParse({ ...valid, currency: 'USD' }).success, false);
});
test('show inputs reject ownership/state injection, venue moves and missing revisions', () => {
  for (const extra of [{ organizerId: valid.venueId }, { eventId: valid.venueId }, { status: 'COMPLETED' }, { revision: 4 }, { seats: [] }]) assert.equal(showInput.safeParse({ ...valid, ...extra }).success, false);
  const { expectedVenueRevision, ...missing } = valid; assert.equal(showInput.safeParse(missing).success, false);
  for (const input of [{}, { priceMinor: 1 }, { expectedRevision: 0 }, { expectedRevision: '0', priceMinor: 1 }, { expectedRevision: 0, venueId: valid.venueId }, { expectedRevision: 0, currency: 'USD' }]) assert.equal(showPatch.safeParse(input).success, false);
  assert.deepEqual(parseInput(showPatch, { expectedRevision: 0, priceMinor: 0 }), { expectedRevision: 0, priceMinor: 0 });
  assert.deepEqual(parseInput(showDelete, { expectedRevision: 0 }), { expectedRevision: 0 });
  for (const input of [{}, { expectedRevision: -1 }, { expectedRevision: 0.1 }, { expectedRevision: 2147483648 }, { expectedRevision: 0, force: true }]) assert.equal(showDelete.safeParse(input).success, false);
});
