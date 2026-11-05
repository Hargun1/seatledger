import { z } from 'zod';
import { createSimulatedEvent,encodeSimulatedEvent } from './events.js';

async function transaction(pool,work) {
  const db=await pool.connect();let discard=false;
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT set_config($1,$2,true),set_config($3,$4,true)',['lock_timeout','250ms','statement_timeout','1500ms']);
    const value=await work(db);await db.query('COMMIT');return value;
  } catch(error) {
    await db.query('ROLLBACK').catch(()=>{discard=true;});discard ||= error.code?.startsWith('08') || error.message==='Query read timeout';throw error;
  } finally {db.release(discard?new Error('Delivery connection unavailable'):undefined);}
}
const identity=z.object({request_key:z.uuid(),plan_index:z.number().int().min(1).max(4)});
function checkedIdentity(job){if(!identity.safeParse(job).success)throw new TypeError('Invalid delivery identity');}
function checkedLease(job){checkedIdentity(job);if(!z.uuid().safeParse(job.lease_token).success)throw new TypeError('Invalid delivery lease');}

export async function materializeDeliveryBatch(pool,{batchSize=5,maxAttempts=8}={}) {
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>20||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>50)throw new TypeError('Invalid delivery planning configuration');
  const rows=(await pool.query(`SELECT p.request_key FROM simulated_provider_payments p WHERE EXISTS(
    SELECT 1 FROM generate_series(1,jsonb_array_length(p.plan)) n WHERE NOT EXISTS(
      SELECT 1 FROM simulated_event_deliveries d WHERE d.request_key=p.request_key AND d.plan_index=n))
    ORDER BY p.created_at,p.request_key LIMIT $1`,[batchSize])).rows;
  const counts={providers:rows.length,planned:0,planningFailed:0};
  for(const row of rows) {
    try {counts.planned+=await transaction(pool,async db=>{
      const p=(await db.query(`SELECT request_key AS "requestKey",payment_attempt_id AS "paymentAttemptId",provider_payment_id AS "providerPaymentId",
        amount_minor::text AS amount,currency,plan,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
        FROM simulated_provider_payments WHERE request_key=$1`,[row.request_key])).rows[0];
      const receipt={...p,amountMinor:Number(p.amount),paymentMode:'simulated'};let inserted=0;
      for(const [index,entry] of p.plan.entries()) {
        const event=createSimulatedEvent(receipt,entry),body=encodeSimulatedEvent(event),ordinal=index+1;
        const result=await db.query(`INSERT INTO simulated_event_deliveries(request_key,plan_index,event_id,event_body,due_at,next_attempt_at,max_attempts)
          SELECT request_key,($2::integer)::smallint,$3,$4,created_at+((plan->($2::integer-1)->>'deliverAfterMs')::integer*interval '1 millisecond'),
            created_at+((plan->($2::integer-1)->>'deliverAfterMs')::integer*interval '1 millisecond'),$5
          FROM simulated_provider_payments WHERE request_key=$1 ON CONFLICT(request_key,plan_index) DO NOTHING`,[p.requestKey,ordinal,event.eventId,body,maxAttempts]);
        inserted+=result.rowCount;
        const saved=(await db.query(`SELECT d.event_id,d.event_body,d.due_at=p.created_at+((p.plan->($2::integer-1)->>'deliverAfterMs')::integer*interval '1 millisecond') AS valid_time
          FROM simulated_event_deliveries d JOIN simulated_provider_payments p ON p.request_key=d.request_key
          WHERE d.request_key=$1 AND d.plan_index=$2::integer`,[p.requestKey,ordinal])).rows[0];
        if(!saved || saved.event_id!==event.eventId || !saved.event_body.equals(body) || !saved.valid_time)throw new Error('Saved delivery identity mismatch');
      }return inserted;
    });}catch{counts.planningFailed++;}
  }return counts;
}

export async function claimDeliveries(pool,{workerId,batchSize=5,leaseSeconds=30}={}) {
  if(typeof workerId!=='string'||workerId.length<1||workerId.length>100||/[^A-Za-z0-9._:-]/.test(workerId)||!Number.isInteger(batchSize)||batchSize<1||batchSize>10||!Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300)throw new TypeError('Invalid delivery claim configuration');
  return transaction(pool,async db=>{
    const exhausted=await db.query(`WITH candidates AS(SELECT request_key,plan_index FROM simulated_event_deliveries
      WHERE status='PROCESSING' AND lease_expires_at<=clock_timestamp() AND attempt_count>=max_attempts
      ORDER BY next_attempt_at,request_key,plan_index FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE simulated_event_deliveries d SET status='DEAD_LETTER',completed_at=clock_timestamp(),last_error_code='LEASE_EXHAUSTED',
        lease_token=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL FROM candidates c
      WHERE d.request_key=c.request_key AND d.plan_index=c.plan_index`,[batchSize]);
    const jobs=(await db.query(`WITH candidates AS(SELECT request_key,plan_index FROM simulated_event_deliveries
      WHERE attempt_count<max_attempts AND ((status IN ('READY','RETRY_WAIT') AND next_attempt_at<=clock_timestamp())
        OR (status='PROCESSING' AND lease_expires_at<=clock_timestamp()))
      ORDER BY next_attempt_at,request_key,plan_index FOR UPDATE SKIP LOCKED LIMIT $1), claimed AS(
      UPDATE simulated_event_deliveries d SET status='PROCESSING',attempt_count=d.attempt_count+1,lease_token=gen_random_uuid(),claimed_by=$2,
        claimed_at=clock_timestamp(),lease_expires_at=clock_timestamp()+($3::integer*interval '1 second')
      FROM candidates c WHERE d.request_key=c.request_key AND d.plan_index=c.plan_index RETURNING d.*)
      SELECT * FROM claimed ORDER BY next_attempt_at,request_key,plan_index`,[batchSize,workerId,leaseSeconds])).rows;
    return {jobs,exhausted:exhausted.rowCount};
  });
}
export async function acknowledgeDelivery(pool,job) {
  checkedLease(job);return transaction(pool,async db=>(await db.query(`UPDATE simulated_event_deliveries SET status='DELIVERED',completed_at=clock_timestamp(),last_error_code=NULL,
    lease_token=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
    WHERE request_key=$1 AND plan_index=$2 AND status='PROCESSING' AND lease_token=$3 AND lease_expires_at>clock_timestamp()`,[job.request_key,job.plan_index,job.lease_token])).rowCount===1);
}
export async function failDelivery(pool,job,{retryable=true,code='DELIVERY_TRANSPORT',delaySeconds=5}={}) {
  checkedLease(job);if(typeof retryable!=='boolean'||typeof code!=='string'||code.length<1||code.length>64||/[^A-Z0-9_]/.test(code)||!Number.isInteger(delaySeconds)||delaySeconds<0||delaySeconds>3600)throw new TypeError('Invalid delivery failure');
  return transaction(pool,async db=>{
    const row=(await db.query(`UPDATE simulated_event_deliveries SET status=CASE WHEN $4 AND attempt_count<max_attempts THEN 'RETRY_WAIT' ELSE 'DEAD_LETTER' END,
      completed_at=CASE WHEN $4 AND attempt_count<max_attempts THEN NULL ELSE clock_timestamp() END,
      next_attempt_at=GREATEST(due_at,clock_timestamp()+($6::integer*interval '1 second')),last_error_code=$5,
      lease_token=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL
      WHERE request_key=$1 AND plan_index=$2 AND status='PROCESSING' AND lease_token=$3 AND lease_expires_at>clock_timestamp() RETURNING status`,
    [job.request_key,job.plan_index,job.lease_token,retryable,code,delaySeconds])).rows[0];return row?.status ?? null;
  });
}
export async function requeueDelivery(pool,job,maxAttempts) {
  checkedIdentity(job);if(!Number.isInteger(maxAttempts)||maxAttempts<2||maxAttempts>50)throw new TypeError('Invalid delivery requeue budget');
  return transaction(pool,async db=>(await db.query(`UPDATE simulated_event_deliveries SET status='RETRY_WAIT',max_attempts=$3,manual_requeues=manual_requeues+1,
    next_attempt_at=GREATEST(due_at,clock_timestamp()),completed_at=NULL,last_error_code=NULL
    WHERE request_key=$1 AND plan_index=$2 AND status='DEAD_LETTER' AND max_attempts<$3 AND attempt_count<$3`,[job.request_key,job.plan_index,maxAttempts])).rowCount===1);
}
