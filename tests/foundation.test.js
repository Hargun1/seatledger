import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { reservationInput } from '../packages/shared/src/index.js';

const silent = { info() {}, error() {} };
async function withApi(pool, work) {
  const server = createApp({ pool, logger: silent }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('liveness works without a database; readiness returns sanitized 503', async () => {
  await withApi({ query: async () => { throw new Error('postgres://SECRET_PASSWORD'); } }, async url => {
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    const response = await fetch(`${url}/api/ready`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes('SECRET'), false);
    assert.equal(JSON.parse(body).database, 'unavailable');
  });
});
test('readiness checks the database and reports ready', async () => {
  let calls = 0;
  await withApi({ query: async sql => { assert.equal(sql, 'SELECT 1'); calls++; } }, async url => {
    assert.equal((await fetch(`${url}/api/ready`)).status, 200);
  });
  assert.equal(calls, 1);
});
test('malformed JSON returns 400 without reflecting payload', async () => {
  await withApi({}, async url => {
    const response = await fetch(`${url}/api/ready`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"secret":' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' });
  });
});
test('configuration rejects real payments without exposing connection credentials', () => {
  assert.throws(() => readConfig({ DATABASE_URL: 'secret', PAYMENT_MODE: 'live' }), /^Error: Invalid configuration/);
  assert.equal(readConfig({ DATABASE_URL: 'postgresql://localhost/seatledger', AUTH_SECRET:'ab'.repeat(32) }).PAYMENT_MODE, 'simulated');
  const settings = { DATABASE_URL:'postgresql://localhost/seatledger',AUTH_SECRET:'ab'.repeat(32) };
  assert.equal(readConfig({ ...settings,SIMULATOR_WEBHOOK_SECRET:'cd'.repeat(32) }).SIMULATOR_WEBHOOK_SECRET,'cd'.repeat(32));
  assert.throws(() => readConfig({ ...settings,SIMULATOR_WEBHOOK_SECRET:settings.AUTH_SECRET }), /^Error: Invalid configuration/);
  assert.throws(() => readConfig({ ...settings,SIMULATOR_WEBHOOK_SECRET:'cd'.repeat(32)+'\n' }), /^Error: Invalid configuration/);
});
test('reservation validation rejects duplicated seats and client-supplied prices', () => {
  const id = '30000000-0000-4000-8000-000000000001';
  assert.equal(reservationInput.safeParse({ showId: id, seatIds: [id, id] }).success, false);
  assert.equal(reservationInput.safeParse({ showId: id, seatIds: [id], price: 1 }).success, false);
  const letterId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  assert.equal(reservationInput.safeParse({ showId: id, seatIds: [letterId, letterId.toUpperCase()] }).success, false);
  assert.equal(reservationInput.parse({ showId: letterId.toUpperCase(), seatIds: [letterId.toUpperCase()] }).showId, letterId);
});
