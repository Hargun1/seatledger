import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readConfig } from '../config.js';
import { createPool } from '../db.js';
import { runExpiryLoop as runPollingLoop } from '../reservations/expiry-loop.js';
import { localCallbackUrl } from './delivery-http.js';
import { runDeliveryBatch } from './delivery.js';

const log=record=>process.stdout.write(JSON.stringify({service:'seatledger-simulated-delivery',...record})+'\n');
const controller=new AbortController(),stop=()=>controller.abort();let pool;
try {
  if(process.argv.slice(2).some(arg=>arg!=='--once'))throw new Error();
  const config=readConfig();if(!config.SIMULATOR_WEBHOOK_SECRET)throw new Error();
  const settings=z.object({DELIVERY_BATCH_SIZE:z.coerce.number().int().min(1).max(10).default(5),
    DELIVERY_POLL_MS:z.coerce.number().int().min(250).max(60000).default(1000),
    DELIVERY_LEASE_SECONDS:z.coerce.number().int().min(5).max(300).default(30),
    DELIVERY_HTTP_TIMEOUT_MS:z.coerce.number().int().min(100).max(10000).default(2000),
    DELIVERY_MAX_ATTEMPTS:z.coerce.number().int().min(1).max(50).default(8),SIMULATOR_CALLBACK_URL:z.string().optional()}).safeParse(process.env);
  if(!settings.success)throw new Error();
  const callbackUrl=(settings.data.SIMULATOR_CALLBACK_URL??`http://127.0.0.1:${config.PORT}/api/payments/simulated/events`);
  localCallbackUrl(callbackUrl);
  pool=createPool(config.DATABASE_URL);pool.on('error',()=>log({event:'database-idle-error'}));
  await pool.query('SELECT request_key,plan_index FROM simulated_event_deliveries LIMIT 0');
  process.once('SIGINT',stop);process.once('SIGTERM',stop);const once=process.argv.includes('--once'),workerId='delivery-'+randomUUID();
  log({event:'started',paymentMode:'simulated',once});
  await runPollingLoop({signal:controller.signal,once,batchSize:settings.data.DELIVERY_BATCH_SIZE,pollMs:settings.data.DELIVERY_POLL_MS,
    runBatch:({batchSize,signal})=>runDeliveryBatch(pool,{workerId,batchSize,signal,callbackUrl,secret:config.SIMULATOR_WEBHOOK_SECRET,
      leaseSeconds:settings.data.DELIVERY_LEASE_SECONDS,timeoutMs:settings.data.DELIVERY_HTTP_TIMEOUT_MS,maxAttempts:settings.data.DELIVERY_MAX_ATTEMPTS}),
    onBatch:counts=>{if(once||counts.claimed||counts.planned||counts.deadLettered||counts.planningFailed||counts.failed)log({event:'batch',...counts});if(counts.failed||counts.planningFailed)process.exitCode=1;}});
}catch{log({event:'failed',message:'Local simulator delivery stopped; check database/migrations, callback key and loopback configuration.'});process.exitCode=1;}
finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(pool)await pool.end().catch(()=>{process.exitCode=1;});log({event:'stopped'});}
