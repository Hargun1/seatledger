import { setTimeout as pause } from 'node:timers/promises';
import { runtimeTelemetry } from '../observability.js';

export async function runExpiryLoop({ runBatch, signal, batchSize = 20, pollMs = 1000, once = false, onBatch = () => {} }) {
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60000) throw new TypeError('Expiry poll interval must be 250..60000ms');
  const candidate = process.argv[1]?.split(/[\\/]/).at(-1)?.replace(/-worker\.js$/, '');
  const worker = ['expiry', 'outbox', 'inbox', 'delivery', 'refund', 'event-cancellation'].includes(candidate) ? candidate : 'worker';
  while (!signal?.aborted) {
    const result = await runtimeTelemetry.span('worker.batch', async () => {
      const start = performance.now();
      try { const counts = await runBatch({ batchSize, signal }); runtimeTelemetry.worker(worker, counts, performance.now() - start); return counts; }
      catch (error) { runtimeTelemetry.worker(worker, { failed: 1 }, performance.now() - start); throw error; }
    });
    onBatch(result);
    if (once || signal?.aborted) break;
    try { await pause(pollMs, undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}
