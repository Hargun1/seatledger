import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { createSimulatedPayment } from '../../apps/api/src/payments/simulator.js';
import { createSimulatedEvent,encodeSimulatedEvent,signSimulatedDelivery } from '../../apps/api/src/payments/events.js';
import { processPaymentEvent,runInboxBatch } from '../../apps/api/src/payments/processor.js';
import { runPaymentBatch } from '../../apps/api/src/payments/worker.js';
import { createReservation,releaseReservation } from '../../apps/api/src/reservations/service.js';
import { runExpiryBatch } from '../../apps/api/src/reservations/expiry.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('payment inbox processing confirms or compensates atomically (real PostgreSQL)',{timeout:60000},async t=>{
  const adminPool=createPool(readDatabaseConfig().DATABASE_URL),pools=[],servers=[];let admin,schema,url,callback;
  const secret='cd'.repeat(32),silent={info(){},error(){}};
  async function tx(pool,work){const db=await pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
  async function attemptFor(x,res=x.res,scenario=x.scenario){
    const pay=await tx(pools[0],async db=>{
      const row=(await db.query(`INSERT INTO payment_attempts(reservation_id,show_id,user_id,amount_minor,currency)
        SELECT id,show_id,user_id,total_minor,currency FROM reservations WHERE id=$1 RETURNING *`,[res.id])).rows[0];
      await db.query("INSERT INTO outbox_events(kind,payment_attempt_id,operation_key) VALUES('PAYMENT_CREATE',$1,$2)",[row.id,row.request_key]);return row;
    });
    const receipt=await createSimulatedPayment(pools[0],{requestKey:pay.request_key,paymentAttemptId:pay.id,amountMinor:Number(pay.amount_minor),currency:pay.currency,scenario});
    return {...x,res,pay,receipt,scenario};
  }
  async function fixture({milliseconds=300000,scenario='success'}={}){
    const x=await tx(pools[0],async db=>{
      const f=await paymentFixture(db),show=(await db.query('SELECT * FROM shows WHERE id=$1',[f.show])).rows[0];
      await db.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1",[show.organizer_id,f.user]);
      await db.query("UPDATE events SET status='PUBLISHED' WHERE id=$1",[show.event_id]);
      const seat=(await db.query('SELECT * FROM venue_seats WHERE id=$1',[f.seat])).rows[0],second=randomUUID();
      await db.query("INSERT INTO venue_seats(id,venue_id,section_id,row_label,seat_number) VALUES($1,$2,$3,'A',2)",[second,show.venue_id,seat.section_id]);
      await db.query("INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor,currency) VALUES($1,$2,$3,12345,'INR')",[show.id,second,show.venue_id]);
      const ids=[f.seat,second].sort();
      await db.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 ORDER BY venue_seat_id FOR UPDATE',[show.id]);
      const res=(await db.query(`WITH stamp AS MATERIALIZED(SELECT clock_timestamp()+$3::int*interval '1 millisecond'-interval '5 minutes' AS at)
        INSERT INTO reservations(user_id,show_id,currency,total_minor,created_at,expires_at)
        SELECT $1,$2,'INR',87345,at,at+interval '5 minutes' FROM stamp RETURNING *`,[f.user,show.id,milliseconds])).rows[0];
      await db.query(`INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency)
        SELECT $1,show_id,venue_seat_id,price_minor,currency FROM show_seats WHERE show_id=$2 ORDER BY venue_seat_id`,[res.id,show.id]);
      await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1',[res.id]);
      await db.query("UPDATE show_seats stock SET state='HELD',reservation_id=r.id,expires_at=r.expires_at FROM reservations r WHERE r.id=$1 AND stock.show_id=$2",[res.id,show.id]);
      return {f,res,ids,show,scenario};
    });return attemptFor(x);
  }
  async function receive(x,kind='PAYMENT_SUCCEEDED'){
    const entry=x.receipt.plan.find(p=>p.kind===kind);assert.ok(entry);
    const event=createSimulatedEvent(x.receipt,entry),body=encodeSimulatedEvent(event);
    const response=await fetch(callback,{method:'POST',headers:{'Content-Type':'application/json','X-SeatLedger-Signature':signSimulatedDelivery(body,{secret})},body});
    assert.equal(response.status,202);await response.json();
    return (await pools[0].query('SELECT id FROM payment_events WHERE provider_event_id=$1',[event.eventId])).rows[0].id;
  }
  const payment=async x=>(await pools[0].query('SELECT * FROM payment_attempts WHERE id=$1',[x.pay.id])).rows[0];
  const event=async id=>(await pools[0].query('SELECT * FROM payment_events WHERE id=$1',[id])).rows[0];
  const bookings=async x=>(await pools[0].query('SELECT * FROM bookings WHERE reservation_id=$1',[x.res.id])).rows;
  const refunds=async x=>(await pools[0].query('SELECT * FROM refunds WHERE payment_attempt_id=$1',[x.pay.id])).rows;
  async function compensation(x,reason){
    const pay=await payment(x),rows=await refunds(x);assert.equal(pay.status,'SUCCEEDED');assert.equal(pay.resolution,'REFUND_REQUIRED');assert.equal(pay.booking_id,null);
    assert.equal(rows.length,1);assert.equal(rows[0].reason,reason);assert.equal(rows[0].amount_minor,'87345');
    const jobs=(await pools[0].query("SELECT * FROM outbox_events WHERE kind='REFUND_CREATE' AND refund_id=$1",[rows[0].id])).rows;
    assert.equal(jobs.length,1);assert.equal(jobs[0].status,'READY');assert.equal(jobs[0].operation_key,rows[0].request_key);
  }
  try {
    admin=await adminPool.connect();await admin.query('BEGIN');schema=await installReliabilitySchema(admin);
    for(const file of ['012_simulated_provider.sql','013_payment_event_evidence.sql'])await admin.query(await readFile(new URL('../../db/migrations/'+file,import.meta.url),'utf8'));
    await admin.query('COMMIT');url=new URL(readDatabaseConfig().DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
    for(let i=0;i<2;i++)pools.push(createPool(url.toString()));
    const server=createApp({pool:pools[0],logger:silent,config:{NODE_ENV:'test',AUTH_SECRET:'ab'.repeat(32),SIMULATOR_WEBHOOK_SECRET:secret,PUBLIC_ORIGIN:'http://127.0.0.1'}}).listen(0,'127.0.0.1');servers.push(server);
    await new Promise(resolve=>server.once('listening',resolve));callback=`http://127.0.0.1:${server.address().port}/api/payments/simulated/events`;

    await t.test('two processors confirm one whole saved-price booking before provider finalization, then creation replay preserves it',async()=>{
      const x=await fixture(),id=await receive(x);
      await pools[0].query('UPDATE show_seats SET price_minor=1 WHERE show_id=$1',[x.show.id]);
      const results=await Promise.all(pools.map(p=>processPaymentEvent(p,id)));assert.equal(results.filter(r=>r.outcome==='booked').length,1);
      const rows=await bookings(x);assert.equal(rows.length,1);assert.ok(rows[0].sealed_at);assert.equal(rows[0].total_minor,'87345');
      const items=(await pools[0].query('SELECT price_minor,currency,section_name,row_label,seat_number FROM booking_items WHERE booking_id=$1 ORDER BY seat_number',[rows[0].id])).rows;
      assert.deepEqual(items,[{price_minor:75000,currency:'INR',section_name:'Stalls',row_label:'A',seat_number:1},{price_minor:12345,currency:'INR',section_name:'Stalls',row_label:'A',seat_number:2}]);
      assert.equal((await payment(x)).booking_id,rows[0].id);assert.equal((await event(id)).status,'PROCESSED');
      const creation=await runPaymentBatch(pools[1],{workerId:'creation-after-capture',batchSize:10,scenario:'failure'});assert.equal(creation.completed,1);
      assert.equal((await payment(x)).status,'SUCCEEDED');assert.equal((await payment(x)).resolution,'BOOKED');
      assert.equal((await processPaymentEvent(pools[0],id)).outcome,'skipped');assert.equal((await bookings(x)).length,1);
    });

    await t.test('late success never steals a newer hold; release/expiry races retain whole allocation and compensation',async()=>{
      const x=await fixture({milliseconds:-1000});const newcomer=randomUUID();
      await pools[0].query("INSERT INTO users(id,email,display_name,status) VALUES($1,$2,'New holder','DISABLED')",[newcomer,newcomer+'@test.invalid']);
      const hold=await tx(pools[0],db=>createReservation(db,newcomer,{showId:x.show.id,seatIds:x.ids}));
      const id=await receive(x);assert.equal((await processPaymentEvent(pools[1],id)).outcome,'compensated');await compensation(x,'HOLD_EXPIRED');
      const stock=(await pools[0].query(`SELECT reservation_id,state,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry FROM show_seats WHERE show_id=$1`,[x.show.id])).rows;
      assert.ok(stock.every(s=>s.state==='HELD'&&s.reservation_id===hold.id&&s.expiry===hold.expiresAt));assert.equal((await bookings(x)).length,0);
      const released=await fixture(),rid=await receive(released);
      const race=await Promise.allSettled([processPaymentEvent(pools[0],rid),tx(pools[1],db=>releaseReservation(db,released.f.user,released.res.id))]);
      assert.equal(race[0].status,'fulfilled');
      if(race[0].value.outcome==='booked'){assert.equal(race[1].status,'rejected');assert.equal(race[1].reason.code,'RESERVATION_CLOSED');}
      else {assert.equal(race[0].value.outcome,'compensated');assert.equal(race[1].status,'fulfilled');await compensation(released,'INVENTORY_LOST');}
      const expired=await fixture({milliseconds:-1000}),eid=await receive(expired);
      await Promise.all([processPaymentEvent(pools[0],eid),runExpiryBatch(pools[1],{batchSize:100})]);await compensation(expired,'HOLD_EXPIRED');
      assert.equal((await pools[0].query('SELECT status FROM reservations WHERE id=$1',[expired.res.id])).rows[0].status,'EXPIRED');
      const partial=await fixture(),pid=await receive(partial);
      await pools[0].query("UPDATE show_seats SET state='AVAILABLE',reservation_id=NULL,expires_at=NULL WHERE show_id=$1 AND venue_seat_id=$2",[partial.show.id,partial.ids[0]]);
      assert.equal((await processPaymentEvent(pools[0],pid)).outcome,'compensated');await compensation(partial,'INVENTORY_LOST');assert.equal((await bookings(partial)).length,0);
      const suspended=await fixture(),sid=await receive(suspended);
      await pools[0].query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1",[suspended.show.organizer_id]);
      assert.equal((await processPaymentEvent(pools[1],sid)).outcome,'compensated');await compensation(suspended,'INVENTORY_LOST');
    });

    await t.test('additional successful attempts compensate once; older failure/pending never regress success and failed attempts can succeed late',async()=>{
      const x=await fixture(),second=await attemptFor(x),ids=await Promise.all([receive(x),receive(second)]);
      const outcomes=await Promise.all(ids.map((id,i)=>processPaymentEvent(pools[i],id)));assert.deepEqual(outcomes.map(r=>r.outcome).sort(),['booked','compensated']);
      assert.equal((await bookings(x)).length,1);const loser=(await payment(x)).resolution==='REFUND_REQUIRED'?x:second;await compensation(loser,'DUPLICATE_PAYMENT');
      const late=await fixture({scenario:'late-success'}),failure=await receive(late,'PAYMENT_FAILED');await processPaymentEvent(pools[0],failure);assert.equal((await payment(late)).status,'FAILED');
      const pending=await receive(late,'PAYMENT_PENDING');await processPaymentEvent(pools[1],pending);assert.equal((await payment(late)).status,'FAILED');
      await processPaymentEvent(pools[0],await receive(late));assert.equal((await payment(late)).resolution,'BOOKED');
      const reordered=await fixture({scenario:'out-of-order'});await processPaymentEvent(pools[0],await receive(reordered));
      await processPaymentEvent(pools[1],await receive(reordered,'PAYMENT_PENDING'));await processPaymentEvent(pools[0],await receive(reordered,'PAYMENT_FAILED'));
      assert.equal((await payment(reordered)).status,'SUCCEEDED');assert.equal((await payment(reordered)).resolution,'BOOKED');assert.equal((await refunds(reordered)).length,0);
    });

    await t.test('booking/refund outbox faults roll back every business write; injected post-COMMIT loss replays completed processing',async()=>{
      const x=await fixture(),id=await receive(x);
      await admin.query("CREATE FUNCTION fail_booking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture booking fault'; END $$");
      await admin.query('CREATE TRIGGER fail_booking BEFORE INSERT ON booking_items FOR EACH ROW EXECUTE FUNCTION fail_booking()');
      try {assert.equal((await runInboxBatch(pools[0],{retryDelaySeconds:0})).failed,1);assert.equal((await bookings(x)).length,0);assert.equal((await payment(x)).status,'CREATED');assert.equal((await event(id)).status,'RECEIVED');}
      finally {await admin.query('DROP TRIGGER fail_booking ON booking_items');await admin.query('DROP FUNCTION fail_booking()');}
      assert.equal((await runInboxBatch(pools[1],{retryDelaySeconds:0})).booked,1);
      const late=await fixture({milliseconds:-1000}),lid=await receive(late);
      await admin.query("CREATE FUNCTION fail_refund_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='REFUND_CREATE' THEN RAISE EXCEPTION 'fixture queue fault'; END IF; RETURN NEW; END $$");
      await admin.query('CREATE TRIGGER fail_refund_queue BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_refund_queue()');
      try {assert.equal((await runInboxBatch(pools[0],{retryDelaySeconds:0})).failed,1);assert.equal((await refunds(late)).length,0);assert.equal((await payment(late)).status,'CREATED');assert.equal((await event(lid)).status,'RECEIVED');}
      finally {await admin.query('DROP TRIGGER fail_refund_queue ON outbox_events');await admin.query('DROP FUNCTION fail_refund_queue()');}
      assert.equal((await runInboxBatch(pools[1],{retryDelaySeconds:0})).compensated,1);await compensation(late,'HOLD_EXPIRED');
      const y=await fixture(),yid=await receive(y);let inject=true;
      const fault={connect:async()=>{const db=await pools[0].connect();return {release:e=>db.release(e),query:async(sql,values)=>{const result=await db.query(sql,values);if(sql==='COMMIT'&&inject){inject=false;const e=new Error('fixture commit acknowledgement');e.code='08006';throw e;}return result;}};}};
      await assert.rejects(processPaymentEvent(fault,yid),e=>e.code==='08006');assert.equal((await event(yid)).status,'PROCESSED');
      assert.equal((await processPaymentEvent(pools[1],yid)).outcome,'skipped');assert.equal((await bookings(y)).length,1);
    });

    await t.test('final fresh clock after event writes rolls back a booking that crosses expiry, then compensates on retry',async()=>{
      const x=await fixture({milliseconds:1000}),id=await receive(x);
      await admin.query("CREATE FUNCTION delay_processing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='PROCESSED' THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$");
      await admin.query('CREATE TRIGGER delay_processing BEFORE UPDATE ON payment_events FOR EACH ROW EXECUTE FUNCTION delay_processing()');
      try {assert.equal((await pools[0].query('SELECT expires_at>clock_timestamp() AS live FROM reservations WHERE id=$1',[x.res.id])).rows[0].live,true);
        await assert.rejects(processPaymentEvent(pools[0],id),e=>e.code==='BOOKING_WINDOW_CLOSED');
        assert.equal((await bookings(x)).length,0);assert.equal((await payment(x)).status,'CREATED');assert.equal((await event(id)).status,'RECEIVED');
      } finally {await admin.query('DROP TRIGGER delay_processing ON payment_events');await admin.query('DROP FUNCTION delay_processing()');}
      assert.equal((await processPaymentEvent(pools[1],id)).outcome,'compensated');await compensation(x,'HOLD_EXPIRED');
    });

    await t.test('observed inventory wait holds no reservation lock; separate CLI processes resume durable rows and leave legacy evidence for review',async()=>{
      const x=await fixture(),id=await receive(x),blocker=await pools[0].connect();let running;
      try {
        await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await blocker.query('SELECT venue_seat_id FROM show_seats WHERE show_id=$1 ORDER BY venue_seat_id FOR UPDATE',[x.show.id]);
        running=processPaymentEvent(pools[1],id).then(value=>({value}),error=>({error}));let observed=false;
        for(let i=0;i<30;i++){observed=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='seatledger' AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))) AS yes",[pid])).rows[0].yes;if(observed)break;await pause(5);}
        assert.equal(observed,true);await admin.query('BEGIN');await admin.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE NOWAIT',[x.res.id]);await admin.query('ROLLBACK');
        await blocker.query('COMMIT');const result=await running;if(result.error)throw result.error;assert.equal(result.value.outcome,'booked');
      } finally {await admin.query('ROLLBACK');await blocker.query('ROLLBACK');blocker.release();if(running)await running;}
      const y=await fixture();await receive(y);const cwd=fileURLToPath(new URL('../../',import.meta.url));
      const run=async()=>{const result=await promisify(execFile)(process.execPath,['apps/api/src/payments/inbox-worker.js','--once'],{cwd,env:{...process.env,DATABASE_URL:url.toString(),PAYMENT_MODE:'simulated',INBOX_BATCH_SIZE:'50'},windowsHide:true,timeout:10000});
        assert.equal(result.stderr,'');const records=result.stdout.trim().split('\n').map(s=>JSON.parse(s)).filter(row=>row.service==='seatledger-simulated-inbox');assert.equal(records.at(-1).event,'stopped');return records.find(r=>r.event==='batch');};
      assert.equal((await run()).booked,1);assert.equal((await payment(y)).resolution,'BOOKED');
      await pools[0].query(`INSERT INTO payment_events(provider_event_id,payment_attempt_id,provider_payment_id,kind,amount_minor,currency,payload_hash,verified_at)
        VALUES($1,$2,$3,'PAYMENT_SUCCEEDED',87345,'INR',$4,clock_timestamp())`,[randomUUID(),y.pay.id,y.receipt.providerPaymentId,Buffer.alloc(32)]);
      assert.equal((await run()).selected,0);
    });
  } finally {
    for(const server of servers)await new Promise(resolve=>server.close(resolve));for(const pool of pools)await pool.end();
    if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^reliability_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();
  }
});
