import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryInput, titlePattern } from '../apps/api/src/discovery/policy.js';

test('public discovery accepts bounded real UTC days and literal title searches', () => {
  assert.deepEqual(discoveryInput.parse({ q: ' Jazz ', from: '2028-02-29', to: '2028-03-01' }),
    { limit: 20, q: 'Jazz', from: '2028-02-29', to: '2028-03-01' });
  for (const input of [{ limit: 51 }, { after: 'bad' }, { from: '2027-02-29' }, { to: '2027-02-30' },
    { from: '2028-01-02', to: '2028-01-01' }, { from: '2028-01-01T00:00:00Z' }, { q: '' },
    { city: ['Bengaluru', 'Delhi'] }, { unknown: 'value' }]) assert.equal(discoveryInput.safeParse(input).success, false);
  assert.equal(titlePattern('50%_\\'), '%50\\%\\_\\\\%');
});
