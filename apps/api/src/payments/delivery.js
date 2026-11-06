import { randomUUID } from 'node:crypto';
import { retryDelaySeconds as backoff } from '../reliability/retry.js';
import { materializeDeliveryBatch,claimDeliveries,acknowledgeDelivery,failDelivery } from './delivery-store.js';
import { localCallbackUrl,postSimulatedEvent,DeliveryError } from './delivery-http.js';

export async function runDeliveryBatch(pool,{callbackUrl,secret,batchSize=5,leaseSeconds=30,retryDelaySeconds=5,maxAttempts=8,timeoutMs=2000,
  workerId='delivery-'+randomUUID(),signal,transport=postSimulatedEvent}={}) {
  localCallbackUrl(callbackUrl);
  if(typeof secret!=='string'||secret.length!==64||!/^[a-f0-9]{64}$/.test(secret)||!Number.isInteger(batchSize)||batchSize<1||batchSize>10
    || !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000||!Number.isInteger(retryDelaySeconds)||retryDelaySeconds<0||retryDelaySeconds>3600
    || !Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>50
    || typeof workerId!=='string'||workerId.length<1||workerId.length>100||/[^A-Za-z0-9._:-]/.test(workerId))
    throw new TypeError('Invalid simulator delivery configuration');
  const counts={providers:0,planned:0,planningFailed:0,claimed:0,attempted:0,delivered:0,retryScheduled:0,deadLettered:0,stale:0,failed:0};
  if(signal?.aborted)return counts;
  Object.assign(counts,await materializeDeliveryBatch(pool,{batchSize,maxAttempts}));
  if(signal?.aborted)return counts;
  const {jobs,exhausted}=await claimDeliveries(pool,{workerId,batchSize,leaseSeconds});counts.claimed=jobs.length;counts.deadLettered=exhausted;
  for(const job of jobs) {
    if(signal?.aborted)break;counts.attempted++;
    try {
      // Both planning and claim commits ended. No database locks surround HTTP.
      await transport(job.event_body,{callbackUrl,secret,timeoutMs});
      if(await acknowledgeDelivery(pool,job))counts.delivered++;else counts.stale++;
    }catch(error){
      counts.failed++;
      try{const status=await failDelivery(pool,job,{retryable:!(error instanceof DeliveryError)||error.retryable,
        code:error instanceof DeliveryError?error.code:'DELIVERY_TRANSPORT',delaySeconds:backoff(job.attempt_count,retryDelaySeconds)});
        if(status==='RETRY_WAIT')counts.retryScheduled++;else if(status==='DEAD_LETTER')counts.deadLettered++;else counts.stale++;
      }catch{counts.failed++;}
    }
  }return counts;
}
