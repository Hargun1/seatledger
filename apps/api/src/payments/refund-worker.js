import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPool } from '../db.js';
import { readDatabaseConfig } from '../config.js';
import { runExpiryLoop as runPollingLoop } from '../reservations/expiry-loop.js';
import { runRefundBatch } from './refund-jobs.js';

const log = value => process.stdout.write(JSON.stringify({ service: 'seatledger-simulated-refunds', ...value }) + '\n');
const controller = new AbortController(), stop = () => controller.abort(); let pool;
try {
  if (process.argv.slice(2).some(arg => arg !== '--once')) throw new Error();
  const config = z.object({ PAYMENT_MODE: z.literal('simulated').default('simulated'),
    REFUND_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(5),
    REFUND_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
    REFUND_WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30) }).safeParse(process.env);
  if (!config.success) throw new Error();
  pool = createPool(readDatabaseConfig().DATABASE_URL); pool.on('error', () => log({ event: 'database-idle-error' }));
  await pool.query('SELECT request_key,refund_id FROM simulated_provider_refunds LIMIT 0'); // Missing 016 fails before claims.
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const workerId = 'refund-' + randomUUID(), once = process.argv.includes('--once');
  log({ event: 'started', paymentMode: 'simulated', once });
  await runPollingLoop({ signal: controller.signal, once, batchSize: config.data.REFUND_WORKER_BATCH_SIZE, pollMs: config.data.REFUND_WORKER_POLL_MS,
    runBatch: ({ batchSize, signal }) => runRefundBatch(pool, { workerId, batchSize, signal, leaseSeconds: config.data.REFUND_WORKER_LEASE_SECONDS }),
    onBatch: counts => { if (once || counts.claimed) log({ event: 'batch', ...counts }); if (counts.failed) process.exitCode = 1; } });
} catch { log({ event: 'failed', message: 'Simulated refund worker stopped; check migrations/database and worker configuration.' }); process.exitCode = 1; }
finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (pool) await pool.end().catch(() => { process.exitCode = 1; }); log({ event: 'stopped' });
}
