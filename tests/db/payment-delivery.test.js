import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { createReservation } from '../../apps/api/src/reservations/service.js';
import { createPayment } from '../../apps/api/src/payments/service.js';
import { runPaymentBatch } from '../../apps/api/src/payments/worker.js';
import { runInboxBatch } from '../../apps/api/src/payments/processor.js';
import { runRefundBatch } from '../../apps/api/src/payments/refund-jobs.js';
import { readRefundStatus } from '../../apps/api/src/payments/refund-status.js';
import { cancelBooking,cancellationPolicy } from '../../apps/api/src/bookings/cancellation.js';
import { requestEventCancellation,eventCancellationProgress } from '../../apps/api/src/organizers/event-cancellation.js';
import { runEventCancellationBatch } from '../../apps/api/src/organizers/event-cancellation-jobs.js';
import { createSimulatedPayment,simulatedPaymentId,simulatedPlan } from '../../apps/api/src/payments/simulator.js';
import { materializeDeliveryBatch,claimDeliveries,acknowledgeDelivery,failDelivery,requeueDelivery } from '../../apps/api/src/payments/delivery-store.js';
import { runDeliveryBatch } from '../../apps/api/src/payments/delivery.js';
import { postSimulatedEvent } from '../../apps/api/src/payments/delivery-http.js';
import {issueTickets,readTickets} from '../../apps/api/src/bookings/tickets.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

const secret='cd'.repeat(32),silent={info(){},error(){}};
// Opt-in local diagnostics: static stages/safe error codes only. Never print
// connection settings, event bodies, ticket credentials or raw error messages.
const diagnostic=stage=>{if(process.env.SEATLEDGER_TEST_DIAGNOSTICS==='1')process.stderr.write(`[payment-delivery] ${stage}\n`);};
const errorCode=error=>typeof error?.code==='string'&&/^[A-Z0-9_]{1,32}$/.test(error.code)?error.code:'UNCLASSIFIED';
if(process.env.SEATLEDGER_TEST_DIAGNOSTICS==='1'){
  // Monitor preserves Node's normal fatal behavior; do not install an
  // uncaughtException handler or swallow an unhandled rejection.
  process.on('uncaughtExceptionMonitor',error=>diagnostic('uncaught-exception:'+errorCode(error)));
}
diagnostic('module-loaded');
async function withDatabase(work){
  const adminPool=createPool(readDatabaseConfig().DATABASE_URL),pools=[];let admin,schema,server;
  try {
    diagnostic('fixture-start');admin=await adminPool.connect();diagnostic('database-connected');await admin.query('BEGIN');schema=await installReliabilitySchema(admin);diagnostic('base-schema-installed');
    for(const file of ['012_simulated_provider.sql','013_payment_event_evidence.sql','014_simulated_event_delivery.sql','015_admission_tickets.sql','016_simulated_refunds.sql','019_event_cancellation_jobs.sql']){
      diagnostic('migration:'+file);await admin.query(await readFile(new URL('../../db/migrations/'+file,import.meta.url),'utf8'));
    }
    await admin.query('COMMIT');diagnostic('schema-committed');const url=new URL(readDatabaseConfig().DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
    for(let i=0;i<2;i++)pools.push(createPool(url.toString()));
    server=createApp({pool:pools[0],logger:silent,config:{NODE_ENV:'test',AUTH_SECRET:'ab'.repeat(32),SIMULATOR_WEBHOOK_SECRET:secret,PUBLIC_ORIGIN:'http://127.0.0.1'}}).listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));diagnostic('http-listening');const callbackUrl=`http://127.0.0.1:${server.address().port}/api/payments/simulated/events`;
    const tx=async work=>{const db=await pools[0].connect();try{await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
    const make=async({scenario='success',ageMs=0}={})=>{
      const x=await tx(async db=>{
        const f=await paymentFixture(db),show=(await db.query('SELECT * FROM shows WHERE id=$1',[f.show])).rows[0];
        await db.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1",[show.organizer_id,f.user]);await db.query("UPDATE events SET status='PUBLISHED' WHERE id=$1",[show.event_id]);
        let res,pay;
        if(!ageMs){res=await createReservation(db,f.user,{showId:f.show,seatIds:[f.seat]});const created=await createPayment(db,f.user,res.id);pay=(await db.query('SELECT * FROM payment_attempts WHERE id=$1',[created.payment.id])).rows[0];}
        else {
          res=(await db.query(`WITH stamp AS MATERIALIZED(SELECT clock_timestamp()-($3::integer*interval '1 millisecond') AS at)
            INSERT INTO reservations(user_id,show_id,total_minor,currency,created_at,expires_at) SELECT $1,$2,75000,'INR',at,at+interval '5 minutes' FROM stamp RETURNING *`,[f.user,f.show,ageMs])).rows[0];
          await db.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES($1,$2,$3,75000,'INR')",[res.id,f.show,f.seat]);
          await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1',[res.id]);
          await db.query("UPDATE show_seats s SET state='HELD',reservation_id=r.id,expires_at=r.expires_at FROM reservations r WHERE r.id=$1 AND s.show_id=$2",[res.id,f.show]);
          pay=(await db.query(`INSERT INTO payment_attempts(reservation_id,show_id,user_id,amount_minor,currency,created_at)
            SELECT id,show_id,user_id,total_minor,currency,created_at FROM reservations WHERE id=$1 RETURNING *`,[res.id])).rows[0];
        }return {f,show,res,pay};
      });
      if(!ageMs){const created=await runPaymentBatch(pools[0],{workerId:'fixture-creation',batchSize:10,scenario});assert.equal(created.failed,0);}
      else {
        const identity={requestKey:x.pay.request_key,paymentAttemptId:x.pay.id,amountMinor:75000,currency:'INR'};
        await pools[0].query(`INSERT INTO simulated_provider_payments(request_key,payment_attempt_id,request_hash,provider_payment_id,amount_minor,currency,scenario,plan,created_at)
          VALUES($1,$2,$3,$4,75000,'INR',$5,$6::jsonb,clock_timestamp()-($7::integer*interval '1 millisecond'))`,
        [identity.requestKey,identity.paymentAttemptId,createHash('sha256').update(JSON.stringify(identity)).digest(),simulatedPaymentId(identity.requestKey),scenario,JSON.stringify(simulatedPlan(identity.requestKey,scenario)),ageMs]);
      }
      x.receipt=await createSimulatedPayment(pools[0],{requestKey:x.pay.request_key,paymentAttemptId:x.pay.id,amountMinor:75000,currency:'INR',scenario});return x;
    };
    const batch=(options={},pool=pools[0])=>runDeliveryBatch(pool,{callbackUrl,secret,retryDelaySeconds:0,batchSize:10,...options});
    const jobs=async x=>(await pools[0].query('SELECT * FROM simulated_event_deliveries WHERE request_key=$1 ORDER BY plan_index',[x.pay.request_key])).rows;
    const receiptCount=async x=>(await pools[0].query('SELECT count(*)::int AS n FROM payment_events WHERE payment_attempt_id=$1',[x.pay.id])).rows[0].n;
    const pay=async x=>(await pools[0].query('SELECT * FROM payment_attempts WHERE id=$1',[x.pay.id])).rows[0];
    const waitSmallPlans=()=>pools[0].query('SELECT pg_sleep(0.22)');
    const expire=job=>pools[0].query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (lease_expires_at-clock_timestamp())))+0.03) FROM simulated_event_deliveries WHERE request_key=$1 AND plan_index=$2",[job.request_key,job.plan_index]);
    diagnostic('scenario-start');await work({pools,admin,url,callbackUrl,tx,make,batch,jobs,receiptCount,pay,waitSmallPlans,expire});diagnostic('scenario-completed');
  }catch(error){diagnostic('fixture-error:'+errorCode(error));throw error;}
  finally{
    diagnostic('cleanup-start');
    if(server)await new Promise(resolve=>server.close(resolve));for(const pool of pools)await pool.end();
    if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^reliability_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();diagnostic('cleanup-completed');
  }
}

test('durable local simulator delivery, recovery and booking pipeline (real PostgreSQL)',{timeout:60000},async t=>{
  diagnostic('suite-start');
  await t.test('concurrent reconciliation and dispatch deliver duplicate plan slots but create one inbox event and booking',()=>withDatabase(async c=>{
    const x=await c.make({scenario:'duplicate'});
    const errors=[];
    const observed=p=>({query:(...args)=>p.query(...args),connect:async()=>{const db=await p.connect();return {release:e=>db.release(e),query:async(...args)=>{try{return await db.query(...args);}catch(e){errors.push({code:e.code,message:e.message});throw e;}}};}});
    const planned=await Promise.all(c.pools.map(p=>materializeDeliveryBatch(observed(p),{batchSize:5})));assert.equal(planned.reduce((n,r)=>n+r.planned,0),3,JSON.stringify(errors));assert.ok(planned.every(r=>r.planningFailed===0));
    await c.waitSmallPlans();const results=await Promise.all(c.pools.map((p,i)=>c.batch({workerId:'dispatcher-'+i,batchSize:1},p)));
    assert.ok(results.every(r=>r.delivered===1&&r.failed===0));assert.equal((await c.batch()).delivered,1);
    const rows=await c.jobs(x);assert.ok(rows.every(r=>r.status==='DELIVERED'));assert.equal(rows[1].event_id,rows[2].event_id);assert.deepEqual(rows[1].event_body,rows[2].event_body);
    assert.equal(await c.receiptCount(x),2);await runInboxBatch(c.pools[0]);assert.equal((await c.pay(x)).resolution,'BOOKED');
    assert.equal((await c.pools[0].query('SELECT count(*)::int AS n FROM bookings WHERE reservation_id=$1',[x.res.id])).rows[0].n,1);
    const booked=(await c.pay(x)).booking_id;
    await c.tx(db=>issueTickets(db,x.f.user,booked));
    const admission=await readTickets(c.pools[0],x.f.user,booked,'ef'.repeat(32));assert.equal(admission.tickets.length,1);assert.equal(admission.tickets[0].status,'ISSUED');
    await assert.rejects(c.admin.query('UPDATE simulated_event_deliveries SET event_body=event_body||decode($1,$2) WHERE request_key=$3',["00","hex",x.pay.request_key]),e=>e.code==='23514');
    assert.equal((await materializeDeliveryBatch(c.pools[0])).planned,0);
  }));

  await t.test('normal, failed, reordered and late-success timelines traverse signed HTTP and monotonic processing',()=>withDatabase(async c=>{
    for(const scenario of ['success','failure','out-of-order','late-success']){
      const x=await c.make({scenario});await c.waitSmallPlans();const seen=[];
      const result=await c.batch({transport:async(body,options)=>{seen.push(JSON.parse(body).kind);await postSimulatedEvent(body,options);}});assert.equal(result.failed,0);
      assert.deepEqual(seen,[...x.receipt.plan].sort((a,b)=>a.deliverAfterMs-b.deliverAfterMs).map(p=>p.kind));
      assert.equal(result.delivered,x.receipt.plan.length);await runInboxBatch(c.pools[1]);
      assert.equal((await c.pay(x)).status,scenario==='failure'?'FAILED':'SUCCEEDED');
      if(scenario!=='failure')assert.equal((await c.pay(x)).resolution,'BOOKED');
    }
  }));

  await t.test('SQL due times withhold a future six-minute success; an aged delayed fixture compensates without stealing a newer hold',()=>withDatabase(async c=>{
    const future=await c.make({scenario:'delayed-success'});assert.equal((await c.batch()).delivered,1);
    const rows=await c.jobs(future);assert.equal(rows[1].status,'READY');
    assert.equal((await c.pools[0].query('SELECT due_at>clock_timestamp() AS future FROM simulated_event_deliveries WHERE request_key=$1 AND plan_index=2',[future.pay.request_key])).rows[0].future,true);
    const old=await c.make({scenario:'delayed-success',ageMs:420000}),newOwner=randomUUID();
    await c.pools[0].query("INSERT INTO users(id,email,display_name,status) VALUES($1,$2,'New holder','DISABLED')",[newOwner,newOwner+'@test.invalid']);
    const hold=await c.tx(db=>createReservation(db,newOwner,{showId:old.f.show,seatIds:[old.f.seat]}));
    assert.equal((await c.batch()).delivered,2);await runInboxBatch(c.pools[1]);assert.equal((await c.pay(old)).resolution,'REFUND_REQUIRED');
    const stock=(await c.pools[0].query(`SELECT reservation_id,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry FROM show_seats WHERE show_id=$1`,[old.f.show])).rows[0];
    assert.equal(stock.reservation_id,hold.id);assert.equal(stock.expiry,hold.expiresAt);
    assert.equal((await c.pools[0].query('SELECT reason FROM refunds WHERE payment_attempt_id=$1',[old.pay.id])).rows[0].reason,'HOLD_EXPIRED');
    assert.equal((await readRefundStatus(c.pools[0],old.f.user,old.pay.id)).refund.progress,'QUEUED');
    const refunded=await runRefundBatch(c.pools[1],{workerId:'delivery-refund-proof'});assert.equal(refunded.completed,1);assert.equal(refunded.failed,0);
    assert.equal((await readRefundStatus(c.pools[0],old.f.user,old.pay.id)).refund.progress,'COMPLETED');
    const settled=(await c.pools[0].query('SELECT status,provider_refund_id FROM refunds WHERE payment_attempt_id=$1',[old.pay.id])).rows[0];
    assert.equal(settled.status,'SUCCEEDED');assert.match(settled.provider_refund_id,/^sim_ref_[a-f0-9]{64}$/);
    assert.equal((await c.pools[0].query('SELECT reservation_id FROM show_seats WHERE show_id=$1',[old.f.show])).rows[0].reservation_id,hold.id);
    assert.equal((await c.pay(old)).resolution,'REFUND_REQUIRED');
    assert.equal((await runRefundBatch(c.pools[0],{workerId:'delivery-refund-replay'})).completed,0);
  }));

  await t.test('a booked customer cancellation voids tickets, refunds the original capture and preserves a replacement hold',()=>withDatabase(async c=>{
    const x=await c.make();await c.waitSmallPlans();await c.batch();await runInboxBatch(c.pools[1]);
    const paid=await c.pay(x);assert.equal(paid.resolution,'BOOKED');
    await c.tx(db=>issueTickets(db,x.f.user,paid.booking_id));
    assert.equal((await readTickets(c.pools[0],x.f.user,paid.booking_id,'ab'.repeat(32))).tickets[0].status,'ISSUED');
    const cancelled=await c.tx(db=>cancelBooking(db,x.f.user,paid.booking_id,cancellationPolicy({})));
    assert.equal(cancelled.status,'CANCELLED');assert.ok(cancelled.refundId);
    assert.equal((await readTickets(c.pools[0],x.f.user,paid.booking_id,'ab'.repeat(32))).tickets[0].status,'VOID');
    const replacement=await c.tx(db=>createReservation(db,x.f.user,{showId:x.f.show,seatIds:[x.f.seat]}));
    assert.equal((await runRefundBatch(c.pools[1],{workerId:'customer-cancel-refund'})).completed,1);
    assert.equal((await readRefundStatus(c.pools[0],x.f.user,x.pay.id)).refund.progress,'COMPLETED');
    await c.tx(db=>cancelBooking(db,x.f.user,paid.booking_id,cancellationPolicy({})));
    assert.equal((await c.pools[0].query('SELECT reservation_id FROM show_seats WHERE show_id=$1',[x.f.show])).rows[0].reservation_id,replacement.id);
    assert.equal((await c.pay(x)).resolution,'BOOKED','Funding history remains unchanged after refund');
    assert.equal((await runRefundBatch(c.pools[0],{workerId:'customer-cancel-replay'})).completed,0);
  }));

  await t.test('event cancellation drains booked or in-flight payments and tracks refund completion separately from cleanup',()=>withDatabase(async c=>{
    for(const booked of [true,false]){
      const x=await c.make();
      await c.pools[0].query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER')",[x.show.organizer_id,x.f.user]);
      if(booked){await c.waitSmallPlans();await c.batch();await runInboxBatch(c.pools[1]);const paid=await c.pay(x);assert.equal(paid.resolution,'BOOKED');await c.tx(db=>issueTickets(db,x.f.user,paid.booking_id));}
      const requested=await c.tx(db=>requestEventCancellation(db,{user:{id:x.f.user}},x.show.organizer_id,x.show.event_id));
      assert.equal(requested.event.status,'CANCELLED');assert.equal(requested.job.status,'PENDING');
      const batch=await runEventCancellationBatch(c.pools[1],{batchSize:1});assert.equal(batch.failed,0);assert.equal(batch.completedJobs,1);
      assert.equal(batch.cancelledBookings,booked?1:0);assert.equal(batch.releasedHolds,booked?0:1);
      const cleanup=await eventCancellationProgress(c.pools[0],x.show.event_id);assert.equal(cleanup.job.status,'COMPLETED');assert.equal(cleanup.counts.refundsCompleted,0);
      if(!booked){await c.waitSmallPlans();await c.batch();await runInboxBatch(c.pools[1]);assert.equal((await c.pay(x)).resolution,'REFUND_REQUIRED');}
      assert.equal((await runRefundBatch(c.pools[1],{workerId:'event-cancellation-refund'})).completed,1);
      const final=await eventCancellationProgress(c.pools[0],x.show.event_id);assert.equal(final.job.status,'COMPLETED');assert.equal(final.counts.refundRequests,1);assert.equal(final.counts.refundsCompleted,1);
      assert.equal((await c.pools[0].query('SELECT state FROM show_seats WHERE show_id=$1 AND venue_seat_id=$2',[x.f.show,x.f.seat])).rows[0].state,'AVAILABLE');
      if(booked)assert.equal((await readTickets(c.pools[0],x.f.user,(await c.pay(x)).booking_id,'ab'.repeat(32))).tickets[0].status,'VOID');
      else assert.equal((await c.pools[0].query('SELECT count(*)::int AS n FROM bookings WHERE show_id=$1',[x.f.show])).rows[0].n,0);
    }
  }));

  await t.test('lost HTTP acknowledgement retries one receipt, stale owners cannot finish, exhausted leases stay visible and requeue extends budget',()=>withDatabase(async c=>{
    const x=await c.make();
    const lost=await c.batch({batchSize:1,transport:async(...args)=>{await postSimulatedEvent(...args);throw new Error('fixture lost HTTP acknowledgement');}});assert.equal(lost.retryScheduled,1);assert.equal(await c.receiptCount(x),1);
    assert.ok((await c.batch()).delivered>=1);
    const retried=(await c.jobs(x))[0];assert.equal(retried.status,'DELIVERED');assert.equal(retried.attempt_count,2);
    assert.equal((await c.pools[0].query('SELECT count(*)::int AS n FROM payment_events WHERE provider_event_id=$1',[retried.event_id])).rows[0].n,1);
    await c.waitSmallPlans();await c.batch();
    const stale=await c.make();await materializeDeliveryBatch(c.pools[0]);
    const original=(await claimDeliveries(c.pools[0],{workerId:'old',batchSize:1,leaseSeconds:1})).jobs[0];assert.equal(original.request_key,stale.pay.request_key);await c.expire(original);
    const current=(await claimDeliveries(c.pools[1],{workerId:'current',batchSize:1,leaseSeconds:5})).jobs[0];assert.notEqual(original.lease_token,current.lease_token);
    assert.equal(await acknowledgeDelivery(c.pools[0],original),false);assert.equal(await failDelivery(c.pools[0],original),null);
    await postSimulatedEvent(current.event_body,{callbackUrl:c.callbackUrl,secret});assert.equal(await acknowledgeDelivery(c.pools[1],current),true);await c.batch();
    const exhausted=await c.make();await materializeDeliveryBatch(c.pools[0],{maxAttempts:1});
    const claimed=(await claimDeliveries(c.pools[0],{workerId:'crashed-last-owner',batchSize:1,leaseSeconds:1})).jobs[0];assert.equal(claimed.request_key,exhausted.pay.request_key);await c.expire(claimed);
    const reclaim=await claimDeliveries(c.pools[1],{workerId:'sweeper',batchSize:1,leaseSeconds:5});assert.equal(reclaim.exhausted,1);
    for(const job of reclaim.jobs){await postSimulatedEvent(job.event_body,{callbackUrl:c.callbackUrl,secret});assert.equal(await acknowledgeDelivery(c.pools[1],job),true);}
    const dead=(await c.jobs(exhausted))[0];assert.equal(dead.status,'DEAD_LETTER');assert.equal(dead.last_error_code,'LEASE_EXHAUSTED');
    assert.equal(await requeueDelivery(c.pools[0],dead,2),true);const retry=await c.batch();assert.ok(retry.delivered>=1);
    const done=(await c.jobs(exhausted))[0];assert.equal(done.status,'DELIVERED');assert.equal(done.attempt_count,2);assert.equal(done.manual_requeues,1);
  }));

  await t.test('force-terminated dispatcher after callback commit recovers via a fresh CLI without duplicate booking',()=>withDatabase(async c=>{
    const x=await c.make(),cwd=fileURLToPath(new URL('../../',import.meta.url));
    const env={...process.env,NODE_ENV:'test',DATABASE_URL:c.url.toString(),PAYMENT_MODE:'simulated',AUTH_SECRET:'ab'.repeat(32),SIMULATOR_WEBHOOK_SECRET:secret,SIMULATOR_CALLBACK_URL:c.callbackUrl,DELIVERY_BATCH_SIZE:'10',DELIVERY_LEASE_SECONDS:'30'};
    const child=spawn(process.execPath,['tests/helpers/delivery-crash-child.js'],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const exited=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',()=>resolve({code:-1,signal:null}));});let timer;
    try {
      await new Promise((resolve,reject)=>{let output='';timer=setTimeout(()=>reject(new Error('Delivery crash marker was not reached')),10000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('"receipt-committed"'))resolve();});child.once('error',()=>reject(new Error('Could not start owned delivery fixture')));child.once('exit',()=>reject(new Error('Delivery fixture exited before termination')));});clearTimeout(timer);
      assert.equal(await c.receiptCount(x),1);assert.equal((await c.jobs(x))[0].status,'PROCESSING');assert.equal(child.kill('SIGKILL'),true);const exit=await exited;assert.ok(exit.signal||exit.code!==0);
    } finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
    await c.expire((await c.jobs(x))[0]);
    const run=async()=>{const result=await promisify(execFile)(process.execPath,['apps/api/src/payments/delivery-worker.js','--once'],{cwd,env,windowsHide:true,timeout:10000});assert.equal(result.stderr,'');const lines=result.stdout.trim().split('\n').map(s=>JSON.parse(s)).filter(row=>row.service==='seatledger-simulated-delivery');assert.equal(lines.at(-1).event,'stopped');return lines.find(r=>r.event==='batch');};
    const recovered=await run();assert.equal(recovered.delivered,2);assert.equal(recovered.failed,0);assert.equal(await c.receiptCount(x),2);assert.equal((await c.jobs(x))[0].attempt_count,2);
    await runInboxBatch(c.pools[1]);assert.equal((await c.pay(x)).resolution,'BOOKED');assert.equal((await run()).claimed,0);
  }));
});
