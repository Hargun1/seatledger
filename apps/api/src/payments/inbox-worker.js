import { z } from 'zod';
import { createPool } from '../db.js';
import { readDatabaseConfig } from '../config.js';
import { runExpiryLoop as runPollingLoop } from '../reservations/expiry-loop.js';
import { runInboxBatch } from './processor.js';

const log=record=>process.stdout.write(JSON.stringify({service:'seatledger-simulated-inbox',...record})+'\n');
const controller=new AbortController(),stop=()=>controller.abort();let pool;
try {
  if(process.argv.slice(2).some(arg=>arg!=='--once'))throw new Error();
  const settings=z.object({PAYMENT_MODE:z.literal('simulated').default('simulated'),
    INBOX_BATCH_SIZE:z.coerce.number().int().min(1).max(50).default(10),
    INBOX_POLL_MS:z.coerce.number().int().min(250).max(60000).default(1000)}).safeParse(process.env);
  if(!settings.success)throw new Error();
  pool=createPool(readDatabaseConfig().DATABASE_URL);pool.on('error',()=>log({event:'database-idle-error'}));
  await pool.query('SELECT event_body FROM payment_events LIMIT 0');
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const once=process.argv.includes('--once');log({event:'started',paymentMode:'simulated',once});
  await runPollingLoop({signal:controller.signal,once,batchSize:settings.data.INBOX_BATCH_SIZE,pollMs:settings.data.INBOX_POLL_MS,
    runBatch:options=>runInboxBatch(pool,options),onBatch:counts=>{if(once||counts.selected)log({event:'batch',...counts});if(counts.failed)process.exitCode=1;}});
} catch {log({event:'failed',message:'Simulated inbox worker stopped; check database/migrations and configuration.'});process.exitCode=1;}
finally {
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  if(pool)await pool.end().catch(()=>{process.exitCode=1;});log({event:'stopped'});
}
