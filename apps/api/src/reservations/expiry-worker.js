import { z } from 'zod';
import { createPool } from '../db.js';
import { readDatabaseConfig } from '../config.js';
import { runExpiryBatch } from './expiry.js';
import { runExpiryLoop } from './expiry-loop.js';

const log = record => process.stdout.write(JSON.stringify({ service: 'seatledger-expiry', ...record }) + '\n');
const controller = new AbortController(), stop = () => controller.abort();
let pool;
try {
  if (process.argv.slice(2).some(arg => arg !== '--once')) throw new Error('Invalid worker option');
  const parsed = z.object({
    EXPIRY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    EXPIRY_POLL_MS: z.coerce.number().int().min(250).max(60000).default(1000)
  }).safeParse(process.env);
  if (!parsed.success) throw new Error('Invalid expiry configuration');
  const once = process.argv.includes('--once'), config = readDatabaseConfig();
  pool = createPool(config.DATABASE_URL);
  // Idle connection failures must not leak credentials or cause an unhandled
  // EventEmitter error; the next real query determines the process outcome.
  pool.on('error', () => log({ event: 'database-idle-error' }));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  log({ event: 'started', once, batchSize: parsed.data.EXPIRY_BATCH_SIZE, pollMs: parsed.data.EXPIRY_POLL_MS });
  await runExpiryLoop({ runBatch: options => runExpiryBatch(pool, options), signal: controller.signal,
    once, batchSize: parsed.data.EXPIRY_BATCH_SIZE, pollMs: parsed.data.EXPIRY_POLL_MS,
    onBatch: counts => { if (once || counts.selected) log({ event: 'batch', ...counts }); if (counts.failed) process.exitCode = 1; } });
} catch {
  log({ event: 'failed', message: 'Expiry worker stopped; check database availability and worker configuration.' });
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (pool) await pool.end().catch(() => { process.exitCode = 1; });
  log({ event: 'stopped' });
}
