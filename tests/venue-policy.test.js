import test from 'node:test';
import assert from 'node:assert/strict';
import { venueInput, venuePatch, venueDelete, layoutInput } from '../apps/api/src/venues/policy.js';

test('venue metadata is bounded, trimmed, timezone-validated and rejects ownership injection', () => {
  assert.deepEqual(venueInput.parse({ name: '  Small Stage ', city: ' Bengaluru ' }), { name: 'Small Stage', city: 'Bengaluru', timezone: 'Asia/Kolkata' });
  for (const input of [{ name: '', city: 'City' }, { name: 'Stage', city: ' ' }, { name: 'Stage', city: 'City', organizer_id: 'someone' }, { name: 'Stage', city: 'City', timezone: '+05:30' }, { name: 'Stage', city: 'City', timezone: 'Made/Up' }]) assert.equal(venueInput.safeParse(input).success, false);
  for (const zone of ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']) assert.equal(venueInput.safeParse({ name: 'Stage', city: 'City', timezone: zone }).success, true);
});
test('metadata edits and deletion require a numeric revision and a real patch', () => {
  for (const input of [{ expectedRevision: 0 }, { city: 'City' }, { expectedRevision: '0', city: 'City' }, { expectedRevision: -1, city: 'City' }, { expectedRevision: 0, revision: 1, city: 'City' }]) assert.equal(venuePatch.safeParse(input).success, false);
  assert.deepEqual(venuePatch.parse({ expectedRevision: 0, city: ' New City ' }), { expectedRevision: 0, city: 'New City' });
  assert.equal(venueDelete.safeParse({}).success, false); assert.equal(venueDelete.safeParse({ expectedRevision: 0 }).success, true);
});
test('layout grammar rejects duplicate normalized labels, seat IDs and oversized allocations', () => {
  const section = { name: 'Main', rows: [{ label: 'A', seats: 3 }] };
  const input = sections => ({ expectedRevision: 0, sections });
  assert.equal(layoutInput.parse(input([section])).sections[0].rows[0].seats, 3);
  for (const sections of [[], [section, { ...section, name: ' Main ' }], [{ name: 'Main', rows: [{ label: 'A', seats: 2 }, { label: ' A ', seats: 2 }] }], [{ name: 'Main', rows: [{ label: 'A', seats: 0 }] }], [{ name: 'Main', rows: [{ label: 'A', seats: 41 }] }], [{ name: 'Main', rows: [{ label: 'A', seats: 2, id: 'client-seat-id' }] }], [{ name: 'Main', rows: Array.from({ length: 13 }, (_, i) => ({ label: String(i), seats: 40 })) }]]) assert.equal(layoutInput.safeParse(input(sections)).success, false);
  const rows = Array.from({ length: 13 }, (_, i) => ({ label: String(i), seats: i === 12 ? 20 : 40 }));
  assert.equal(layoutInput.safeParse(input([{ name: 'Main', rows }])).success, true); // Exactly 500.
});
