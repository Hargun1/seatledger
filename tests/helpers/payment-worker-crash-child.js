// Spawned only by payment-worker.test.js with its private schema URL.
import { setTimeout as pause } from 'node:timers/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createSimulatedPayment } from '../../apps/api/src/payments/simulator.js';
import { runPaymentBatch } from '../../apps/api/src/payments/worker.js';

const pool = createPool(readDatabaseConfig().DATABASE_URL);
try {
  await runPaymentBatch(pool, { workerId: 'crash-fixture', batchSize: 1, leaseSeconds: 1, scenario: 'delayed-success',
    provider: async (...args) => {
      const result = await createSimulatedPayment(...args);
      process.stdout.write('{"event":"provider-committed"}\n');
      await pause(30000); // Parent force-terminates this owned child at the marker.
      return result;
    } });
} finally { await pool.end(); }
