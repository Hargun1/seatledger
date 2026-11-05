import { setTimeout as pause } from 'node:timers/promises';

export async function runExpiryLoop({ runBatch, signal, batchSize = 20, pollMs = 1000, once = false, onBatch = () => {} }) {
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60000) throw new TypeError('Expiry poll interval must be 250..60000ms');
  while (!signal?.aborted) {
    const result = await runBatch({ batchSize, signal });
    onBatch(result);
    if (once || signal?.aborted) break;
    try { await pause(pollMs, undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}
