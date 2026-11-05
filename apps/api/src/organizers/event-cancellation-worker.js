import {z} from 'zod';
import {createPool} from '../db.js';
import {readDatabaseConfig} from '../config.js';
import {runExpiryLoop} from '../reservations/expiry-loop.js';
import {runEventCancellationBatch} from './event-cancellation-jobs.js';

const log=value=>process.stdout.write(JSON.stringify({service:'seatledger-event-cancellation',...value})+'\n');
const controller=new AbortController(),stop=()=>controller.abort();let pool;
try{
  if(process.argv.slice(2).some(arg=>arg!=='--once'))throw new Error();
  const parsed=z.object({PAYMENT_MODE:z.literal('simulated').default('simulated'),EVENT_CANCELLATION_BATCH_SIZE:z.coerce.number().int().min(1).max(20).default(5),
    EVENT_CANCELLATION_POLL_MS:z.coerce.number().int().min(250).max(60000).default(1000)}).safeParse(process.env);if(!parsed.success)throw new Error();
  pool=createPool(readDatabaseConfig().DATABASE_URL);pool.on('error',()=>log({event:'database-idle-error'}));
  await pool.query('SELECT event_id,generation FROM event_cancellation_jobs LIMIT 0');
  process.once('SIGINT',stop);process.once('SIGTERM',stop);const once=process.argv.includes('--once');log({event:'started',once,paymentMode:'simulated'});
  await runExpiryLoop({signal:controller.signal,once,batchSize:parsed.data.EVENT_CANCELLATION_BATCH_SIZE,pollMs:parsed.data.EVENT_CANCELLATION_POLL_MS,
    runBatch:options=>runEventCancellationBatch(pool,options),onBatch:counts=>{if(once||counts.selected)log({event:'batch',...counts});if(counts.failed)process.exitCode=1;}});
}catch{log({event:'failed',message:'Event cancellation worker stopped; check database, migrations and configuration.'});process.exitCode=1;}
finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(pool)await pool.end().catch(()=>{process.exitCode=1;});log({event:'stopped'});}
