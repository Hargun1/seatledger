import test from 'node:test';
import assert from 'node:assert/strict';
import { readApi } from '../apps/web/src/network/read-api.js';

function clock() {
  let at = 0;
  return { now: () => at, wait: async ms => { at += ms; }, advance: ms => { at += ms; } };
}

test('startup reads recover from gateway errors, timeouts and spinning-up HTML with a fresh GET', async () => {
  const time = clock(), calls = []; let retries = 0;
  const replies = [new Response('gateway', { status: 502 }), new DOMException('slow', 'TimeoutError'),
    new Response('<html>Starting</html>', { headers: { 'Content-Type': 'text/html' } }), Response.json({ ready: true })];
  const response = await readApi('/api/events', { ...time, onRetry: () => retries++, credentials: 'omit', fetchImpl: async (path, options) => {
    calls.push({ path, options }); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply;
  } });
  assert.deepEqual(await response.json(), { ready: true }); assert.equal(retries, 3); assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.path, '/api/events'); assert.equal(call.options.method, 'GET');
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.body, undefined);
  }
});

test('startup recovery does not turn authentication, validation, rate-limit or application failures into retries', async () => {
  for (const status of [200, 400, 401, 403, 404, 409, 429, 500]) {
    let calls = 0;
    const response = await readApi('/api/auth/session', { fetchImpl: async () => { calls++; return Response.json({ error: 'test' }, { status }); },
      wait: async () => assert.fail('Unexpected retry') });
    assert.equal(response.status, status); assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(readApi('/api/events', { fetchImpl: async () => { calls++; throw new TypeError('offline'); } }), TypeError);
  assert.equal(calls, 1);
});

test('persistent startup errors stop at the total budget and do not loop forever', async () => {
  const time = clock(); let calls = 0;
  const result = await readApi('/api/events', { ...time, budgetMs: 5000, retryMs: 2000,
    fetchImpl: async () => { calls++; return new Response('unavailable', { status: 503 }); } });
  assert.equal(result.status, 503); assert.equal(calls, 3); assert.equal(time.now(), 5000);
  const timeoutClock = clock();
  await assert.rejects(readApi('/api/events', { ...timeoutClock, budgetMs: 1000, fetchImpl: async () => {
    timeoutClock.advance(1000); throw new DOMException('timeout', 'TimeoutError');
  } }), { name: 'TimeoutError' });
});

test('leaving a page cancels a startup retry and cannot issue another read', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(readApi('/api/events', { signal: controller.signal, fetchImpl: async () => {
    calls++; return new Response('', { status: 504 });
  }, onRetry: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
