import test from 'node:test';
import assert from 'node:assert/strict';
import { runExpiryLoop } from '../apps/api/src/reservations/expiry-loop.js';

test('shutdown finishes the active batch without starting another, and once mode runs one batch', async () => {
  const controller = new AbortController(); let finish, calls = 0, reports = 0;
  const running = runExpiryLoop({ signal: controller.signal, runBatch: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, onBatch: () => reports++ });
  controller.abort(); assert.equal(calls, 1); assert.equal(reports, 0);
  finish({ selected: 1 }); await running; assert.equal(calls, 1); assert.equal(reports, 1);
  await runExpiryLoop({ once: true, runBatch: async () => { calls++; return {}; } }); assert.equal(calls, 2);
});

test('shutdown interrupts idle polling; invalid cadence and batch failure do not hot-loop', async () => {
  const controller = new AbortController(); let calls = 0;
  const running = runExpiryLoop({ signal: controller.signal, runBatch: async () => { calls++; return {}; }, onBatch: () => queueMicrotask(() => controller.abort()) });
  await running; assert.equal(calls, 1);
  await assert.rejects(runExpiryLoop({ pollMs: 0, runBatch: async () => {} }), TypeError);
  await assert.rejects(runExpiryLoop({ runBatch: async () => { throw new Error('offline'); } }), /offline/);
});
