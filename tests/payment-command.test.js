import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentCommand, paymentPageQuery } from '../apps/api/src/payments/commands.js';

test('payment command binds the authenticated user/key to one canonical reservation and accepts no client payment authority', () => {
  const user = 'abcdefab-abcd-4abc-8abc-abcdefabcdea', id = 'abcdefab-abcd-4abc-8abc-abcdefabcdeb';
  const first = paymentCommand(user.toUpperCase(), 'key', {}, id.toUpperCase());
  assert.deepEqual(first, paymentCommand(user, 'key', {}, id)); assert.equal(first.input.operation, 'payment.create');
  assert.equal(first.input.requestHash.equals(paymentCommand(id, 'key', {}, id).input.requestHash), true);
  assert.notEqual(first.input.userId, paymentCommand(id, 'key', {}, id).input.userId);
  assert.equal(first.input.requestHash.equals(paymentCommand(user, 'key', {}, user).input.requestHash), false);
  for (const body of [{ amountMinor: 1 }, { currency: 'INR' }, { provider: 'real' }, { paid: true }, { userId: user }, { reservationId: id }]) assert.throws(() => paymentCommand(user, 'key', body, id), { status: 400 });
  for (const key of ['', 'has space', undefined, 'x'.repeat(129)]) assert.throws(() => paymentCommand(user, key, {}, id), { status: 400 });
  assert.throws(() => paymentCommand(user, 'key', {}, 'bad'), { status: 404 });
  assert.equal(paymentPageQuery.safeParse({ after: id }).success, true);
  for (const query of [{ after: [id] }, { limit: '500' }, { userId: user }]) assert.equal(paymentPageQuery.safeParse(query).success, false);
});
