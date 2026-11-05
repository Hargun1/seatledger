import test from 'node:test';
import assert from 'node:assert/strict';
import { publishInput, publicationToken } from '../apps/api/src/publication/policy.js';

test('publication accepts only one exact SHA-256 review token, never client inventory or prices', () => {
  assert.deepEqual(publishInput.parse({ reviewToken: 'a'.repeat(64) }), { reviewToken: 'a'.repeat(64) });
  for (const body of [{}, { reviewToken: '' }, { reviewToken: 'A'.repeat(64) }, { reviewToken: 'a'.repeat(63) }, { reviewToken: 'g'.repeat(64) }, { reviewToken: 1 }, { reviewToken: 'a'.repeat(64), priceMinor: 0 }, { reviewToken: 'a'.repeat(64), seats: [] }, { reviewToken: 'a'.repeat(64), force: true }]) assert.equal(publishInput.safeParse(body).success, false);
});
test('publication comparison includes review revision and exact database snapshot values', () => {
  const original = { event: { publicationRevision: 4, title: 'Talk' }, shows: [{ startsAt: '2030-01-01T00:00:00.123456Z', priceMinor: 100 }] };
  const token = publicationToken(original); assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(publicationToken(JSON.parse(JSON.stringify(original))), token);
  assert.notEqual(publicationToken({ ...original, event: { ...original.event, publicationRevision: 5 } }), token);
  assert.notEqual(publicationToken({ ...original, shows: [{ ...original.shows[0], startsAt: '2030-01-01T00:00:00.123457Z' }] }), token);
  assert.notEqual(publicationToken({ ...original, shows: [{ ...original.shows[0], priceMinor: 101 }] }), token);
});
