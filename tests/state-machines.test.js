import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, requireTransition } from '../packages/shared/src/state-machines.js';

test('late failure cannot regress successful payment; late success is still accounted for', () => {
  assert.equal(canTransition('payment', 'SUCCEEDED', 'FAILED'), false);
  assert.equal(canTransition('payment', 'SUCCEEDED', 'PENDING'), false);
  assert.equal(canTransition('payment', 'FAILED', 'SUCCEEDED'), true);
});
test('expired or released reservations cannot be confirmed', () => {
  for (const from of ['EXPIRED', 'RELEASED', 'CONFIRMED']) {
    assert.throws(() => requireTransition('reservation', from, 'CONFIRMED'));
  }
  assert.doesNotThrow(() => requireTransition('reservation', 'ACTIVE', 'CONFIRMED'));
});
test('inventory must pass through a hold; cancelled booking cannot be revived', () => {
  assert.equal(canTransition('seat', 'AVAILABLE', 'BOOKED'), false);
  assert.equal(canTransition('booking', 'CANCELLED', 'CONFIRMED'), false);
  assert.equal(canTransition('seat', 'BOOKED', 'AVAILABLE'), true);
});
