import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPool } from '../db.js';
import { readDatabaseConfig } from '../config.js';
import { runExpiryLoop as runPollingLoop } from '../reservations/expiry-loop.js';
import { simulatorScenarios } from './simulator.js';
import { runPaymentBatch } from './worker.js';

const log = value => process.stdout.write(JSON.stringify({ service: 'seatledger-simulated-payments', ...value }) + '\n');
const controller = new AbortController(), stop = () => controller.abort(); let pool;
try {
  if (process.argv.slice(2).some(arg => arg !== '--once')) throw new Error();
  const config = z.object({ PAYMENT_MODE: z.literal('simulated').default('simulated'),
    PAYMENT_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(5),
    PAYMENT_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
    PAYMENT_WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    SIMULATOR_SCENARIO: z.enum(simulatorScenarios).default('success') }).safeParse(process.env);
  if (!config.success) throw new Error();
  pool = createPool(readDatabaseConfig().DATABASE_URL); pool.on('error', () => log({ event: 'database-idle-error' }));
  await pool.query('SELECT request_key FROM simulated_provider_payments LIMIT 0'); // Fail before claiming work if 012 is missing.
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const workerId = 'payment-' + randomUUID(), once = process.argv.includes('--once');
  log({ event: 'started', paymentMode: 'simulated', once, scenario: config.data.SIMULATOR_SCENARIO });
  await runPollingLoop({ signal: controller.signal, once, batchSize: config.data.PAYMENT_WORKER_BATCH_SIZE, pollMs: config.data.PAYMENT_WORKER_POLL_MS,
    runBatch: ({ batchSize, signal }) => runPaymentBatch(pool, { workerId, batchSize, signal,
      leaseSeconds: config.data.PAYMENT_WORKER_LEASE_SECONDS, scenario: config.data.SIMULATOR_SCENARIO }),
    onBatch: counts => { if (once || counts.claimed) log({ event: 'batch', ...counts }); if (counts.failed) process.exitCode = 1; } });
} catch { log({ event: 'failed', message: 'Simulated payment worker stopped; check database/migrations and worker configuration.' }); process.exitCode = 1; }
finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (pool) await pool.end().catch(() => { process.exitCode = 1; }); log({ event: 'stopped' });
}
