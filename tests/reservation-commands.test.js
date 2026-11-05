import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationCommand, reservationRecoveryQuery, parseReservationValue } from '../apps/api/src/reservations/commands.js';
import { reservationInput as installedInput } from '@seatledger/shared';
import { reservationInput as canonicalInput } from '../packages/shared/src/index.js';

const user = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const show = '60000000-0000-4000-8000-000000000001';
const a = 'abcdefab-abcd-4abc-8abc-abcdefabcdea';
const b = 'abcdefab-abcd-4abc-8abc-abcdefabcdeb';

test('equivalent holds have one canonical hash without mutating caller input', () => {
  assert.equal(installedInput, canonicalInput, 'The production shared import must reach the live canonical schema; repair a stale copied workspace package');
  const raw = { seatIds: [b.toUpperCase(), a], showId: show }, before = structuredClone(raw);
  const first = reservationCommand('reservation.create', user.toUpperCase(), 'same-key', raw);
  const second = reservationCommand('reservation.create', user, 'same-key', { showId: show, seatIds: [a, b] });
  assert.deepEqual(raw, before);
  assert.deepEqual(first, second);
  assert.deepEqual(first.body.seatIds, [a, b]);
  assert.equal(first.input.requestHash.length, 32);
  const changed = reservationCommand('reservation.create', user, 'same-key', { showId: show, seatIds: [a] });
  assert.equal(first.input.requestHash.equals(changed.input.requestHash), false);
});

test('idempotency identity retains authenticated user, operation and exact key scope', () => {
  const create = reservationCommand('reservation.create', user, 'key-1', { showId: show, seatIds: [a] });
  const otherUser = reservationCommand('reservation.create', b, 'key-1', { showId: show, seatIds: [a] });
  assert.equal(create.input.requestHash.equals(otherUser.input.requestHash), true);
  assert.notEqual(create.input.userId, otherUser.input.userId); // DB uniqueness includes scope, not hash alone.
  const release = reservationCommand('reservation.release', user, 'key-1', {}, a.toUpperCase());
  assert.equal(release.body.id, a); assert.equal(release.input.operation, 'reservation.release');
  assert.notEqual(create.input.operation, release.input.operation);
  for (const key of [undefined, '', 'has space', 'x'.repeat(129), ['key']]) assert.throws(() => reservationCommand('reservation.release', user, key, {}, a), { status: 400 });
});

test('unknown operations, client authority/price, mixed-case duplicates and release extras fail before SQL', () => {
  for (const operation of ['__proto__', 'constructor', 'reservation.confirm']) assert.throws(() => reservationCommand(operation, user, 'key', {}), { status: 400 });
  for (const body of [{ showId: show, seatIds: [a], priceMinor: 1 }, { showId: show, seatIds: [a], userId: b },
    { showId: show, seatIds: [a, a.toUpperCase()] }]) assert.throws(() => reservationCommand('reservation.create', user, 'key', body), { status: 400 });
  assert.throws(() => reservationCommand('reservation.release', user, 'key', { expiresAt: '2090-01-01' }, a), { status: 400 });
  assert.throws(() => reservationCommand('reservation.release', user, 'key', {}, 'bad'), { status: 404 });
});

test('recovery query is normalized, bounded by a fixed page size and accepts no caller identity', () => {
  assert.deepEqual(parseReservationValue(reservationRecoveryQuery, { showId: user.toUpperCase(), after: a.toUpperCase() }), { showId: user, after: a });
  assert.deepEqual(parseReservationValue(reservationRecoveryQuery, { showId: show }), { showId: show });
  for (const query of [{}, { showId: 'bad' }, { showId: [show, show] }, { showId: show, userId: user },
    { showId: show, after: '' }, { showId: show, after: [a, b] }, { showId: show, limit: '100000' }]) {
    assert.throws(() => parseReservationValue(reservationRecoveryQuery, query), { status: 400 });
  }
});
