import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { createSimulatedPayment, simulatedPaymentId, simulatedPlan } from '../../apps/api/src/payments/simulator.js';
import { createSimulatedEvent, encodeSimulatedEvent, signSimulatedDelivery } from '../../apps/api/src/payments/events.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('signed callback HTTP and durable inbox (real PostgreSQL, two APIs)', { timeout:60000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL), pools = [], servers = [], urls = [];
  const secret = 'cd'.repeat(32), silent = { info(){},error(){} };
  const config = { NODE_ENV:'test',AUTH_SECRET:'ab'.repeat(32),PUBLIC_ORIGIN:'http://127.0.0.1',PAYMENT_MODE:'simulated',SIMULATOR_WEBHOOK_SECRET:secret };
  let admin,schema,f;
  async function api(pool, settings = config) {
    const server = createApp({pool,config:settings,logger:silent}).listen(0,'127.0.0.1'); servers.push(server);
    await new Promise(resolve => server.once('listening',resolve));
    return `http://127.0.0.1:${server.address().port}/api/payments/simulated/events`;
  }
  const hash = body => createHash('sha256').update(body).digest();
  const send = async (body,{url=urls[0],headers={},signature=signSimulatedDelivery(body,{secret}),query=''}={}) => {
    const response = await fetch(url+query,{method:'POST',headers:{'Content-Type':'application/json','X-SeatLedger-Signature':signature,...headers},body});
    return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control'),retry:response.headers.get('retry-after')};
  };
  const eventRow = async id => (await pools[0].query('SELECT * FROM payment_events WHERE provider_event_id=$1',[id])).rows[0];
  const count = async () => (await pools[0].query('SELECT count(*)::int AS n FROM payment_events')).rows[0].n;
  async function fixture({expired=false,provider=true,scenario='success'}={}) {
    await admin.query('BEGIN'); let res,pay;
    try {
      if (expired) {
        res = (await admin.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp()-interval '6 minutes' AS at)
          INSERT INTO reservations(user_id,show_id,total_minor,currency,created_at,expires_at)
          SELECT $1,$2,75000,'INR',at,at+interval '5 minutes' FROM stamp RETURNING *`,[f.user,f.show])).rows[0];
        await admin.query('INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES($1,$2,$3,75000,$4)',[res.id,f.show,f.seat,'INR']);
        await admin.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1',[res.id]);
      } else res = await f.reservation();
      pay = (await admin.query('INSERT INTO payment_attempts(reservation_id,show_id,user_id,amount_minor,currency) VALUES($1,$2,$3,75000,$4) RETURNING *',[res.id,f.show,f.user,'INR'])).rows[0];
      await admin.query('COMMIT');
    } catch(error) { await admin.query('ROLLBACK'); throw error; }
    const receipt = provider ? await createSimulatedPayment(pools[0],{requestKey:pay.request_key,paymentAttemptId:pay.id,amountMinor:75000,currency:'INR',scenario})
      : {requestKey:pay.request_key,paymentAttemptId:pay.id,providerPaymentId:simulatedPaymentId(pay.request_key),amountMinor:75000,currency:'INR',createdAt:new Date().toISOString(),paymentMode:'simulated',plan:simulatedPlan(pay.request_key,scenario)};
    const event = createSimulatedEvent(receipt,receipt.plan[1]);
    return {res,pay,receipt,event,body:encodeSimulatedEvent(event)};
  }
  const acknowledged = result => { assert.equal(result.status,202); assert.deepEqual(result.body,{status:'recorded',paymentMode:'simulated'}); assert.equal(result.cache,'no-store'); };
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin);
    for (const file of ['012_simulated_provider.sql','013_payment_event_evidence.sql']) await admin.query(await readFile(new URL('../../db/migrations/'+file,import.meta.url),'utf8'));
    f = await paymentFixture(admin); await admin.query('COMMIT');
    const url = new URL(readDatabaseConfig().DATABASE_URL); url.searchParams.set('options',`-c search_path=${schema},public`);
    for(let i=0;i<2;i++) { pools.push(createPool(url.toString())); urls.push(await api(pools[i])); }

    await t.test('concurrent authenticated deliveries save one immutable event before provider finalization; expiry and receipt replay never book',async()=>{
      const x = await fixture({scenario:'duplicate'});
      for (const result of await Promise.all(Array.from({length:8},(_,i)=>send(x.body,{url:urls[i%2]})))) acknowledged(result);
      assert.equal(await count(),1);
      const saved = await eventRow(x.event.eventId); assert.equal(saved.status,'RECEIVED');
      assert.deepEqual(saved.event_body,x.body); assert.deepEqual(saved.payload_hash,hash(x.body));
      assert.equal(saved.occurred_at.toISOString(),x.event.occurredAt);
      assert.deepEqual((await pools[0].query('SELECT status,provider_payment_id FROM payment_attempts WHERE id=$1',[x.pay.id])).rows[0],{status:'CREATED',provider_payment_id:null});
      for(const sql of ["UPDATE payment_events SET event_body=event_body||decode('00','hex') WHERE id=$1","UPDATE payment_events SET occurred_at=occurred_at+interval '1 second' WHERE id=$1"])
        await assert.rejects(admin.query(sql,[saved.id]),e=>e.code==='23514'&&e.constraint==='payment_events_wire_immutable');
      // Trusted fixture transition only: receipt replay must not reset processing.
      await admin.query("UPDATE payment_events SET status='PROCESSED',processed_at=clock_timestamp() WHERE id=$1",[saved.id]);
      acknowledged(await send(x.body,{url:urls[1]})); assert.equal((await eventRow(x.event.eventId)).status,'PROCESSED');
      const expired = await fixture({expired:true}); acknowledged(await send(expired.body));
      assert.equal((await eventRow(expired.event.eventId)).status,'RECEIVED');
      assert.equal((await pools[0].query('SELECT status FROM reservations WHERE id=$1',[expired.res.id])).rows[0].status,'ACTIVE');
      assert.equal((await pools[0].query('SELECT expires_at<clock_timestamp() AS expired FROM reservations WHERE id=$1',[expired.res.id])).rows[0].expired,true);
      const reordered=await fixture({scenario:'out-of-order'});
      for(const entry of reordered.receipt.plan) acknowledged(await send(encodeSimulatedEvent(createSimulatedEvent(reordered.receipt,entry))));
      assert.equal((await pools[0].query("SELECT count(*)::int AS n FROM payment_events WHERE payment_attempt_id=$1 AND status='RECEIVED'",[reordered.pay.id])).rows[0].n,3);
      assert.equal((await pools[0].query('SELECT status FROM payment_attempts WHERE id=$1',[reordered.pay.id])).rows[0].status,'CREATED');
      assert.equal((await pools[0].query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
      assert.equal((await pools[0].query('SELECT state FROM show_seats WHERE show_id=$1',[f.show])).rows[0].state,'AVAILABLE');
    });

    await t.test('signed mapping/amount/currency/plan errors are retained as REJECTED; same-ID different evidence conflicts',async()=>{
      for(const [patch,reason] of [
        [e=>({...e,amountMinor:1}),'AMOUNT_MISMATCH'],[e=>({...e,currency:'USD'}),'CURRENCY_MISMATCH'],
        [e=>({...e,providerPaymentId:'sim_pay_'+'0'.repeat(64)}),'PAYMENT_MAPPING_MISMATCH'],
        [e=>({...e,eventId:'sim_evt_'+randomBytes(32).toString('hex')}),'EVENT_PLAN_MISMATCH'],
        [e=>({...e,paymentAttemptId:randomUUID()}),'UNKNOWN_PAYMENT']]) {
        const x=await fixture(), event=patch(x.event),body=encodeSimulatedEvent(event); acknowledged(await send(body));
        const saved=await eventRow(event.eventId); assert.equal(saved.status,'REJECTED'); assert.equal(saved.rejection_code,reason);
        assert.deepEqual(saved.event_body,body); assert.ok(saved.processed_at); if(reason==='UNKNOWN_PAYMENT') assert.equal(saved.payment_attempt_id,null);
        acknowledged(await send(body,{url:urls[1]})); assert.equal((await eventRow(event.eventId)).rejection_code,reason);
      }
      const missing=await fixture({provider:false}); acknowledged(await send(missing.body));
      assert.equal((await eventRow(missing.event.eventId)).rejection_code,'PROVIDER_RECORD_MISSING');
      const x=await fixture(); acknowledged(await send(x.body));
      const changed=await send(encodeSimulatedEvent({...x.event,amountMinor:1}),{url:urls[1]}); assert.equal(changed.status,409);
      assert.deepEqual(changed.body,{error:'EVENT_IDENTITY_CONFLICT'}); assert.deepEqual((await eventRow(x.event.eventId)).event_body,x.body);
    });

    await t.test('raw HTTP guards reject unauthenticated, oversized, compressed and noncanonical requests; missing key disables the endpoint',async()=>{
      const x=await fixture(),before=await count();
      assert.equal((await send(x.body,{signature:'invalid'})).status,401);
      assert.equal((await send(x.body,{signature:signSimulatedDelivery(x.body,{secret,nowMs:Date.now()-301000})})).status,401);
      assert.equal((await send(x.body,{headers:{'Content-Type':'text/plain'}})).status,415);
      assert.equal((await send(x.body,{headers:{'Content-Encoding':'gzip'}})).status,415);
      assert.equal((await send(x.body,{query:'?paid=true'})).status,400);
      assert.equal((await send(Buffer.alloc(8193,32),{signature:signSimulatedDelivery(x.body,{secret})})).status,413);
      const noncanonical=Buffer.from(x.body.toString()+'\n'); assert.equal((await send(noncanonical)).status,400);
      const duplicate=await new Promise((resolve,reject)=>{
        const req=request(urls[0],{method:'POST',headers:['Host',new URL(urls[0]).host,'Content-Type','application/json','X-SeatLedger-Signature',signSimulatedDelivery(x.body,{secret}),'X-SeatLedger-Signature',signSimulatedDelivery(x.body,{secret})]},res=>{
          const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
        });req.on('error',reject);req.end(x.body);
      }); assert.equal(duplicate.status,401); assert.deepEqual(duplicate.body,{error:'SIMULATED_EVENT_UNVERIFIED'});
      const disabled=await api(pools[0],{...config,SIMULATOR_WEBHOOK_SECRET:undefined});
      assert.equal((await send(x.body,{url:disabled})).status,503); assert.equal(await count(),before);
    });

    await t.test('insert faults return sanitized retryable 503 with rollback; simulated lost COMMIT acknowledgement retries one receipt',async()=>{
      const x=await fixture();
      await admin.query("CREATE FUNCTION fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-secret'; END $$");
      await admin.query('CREATE TRIGGER fail_inbox BEFORE INSERT ON payment_events FOR EACH ROW EXECUTE FUNCTION fail_inbox()');
      try { const failed=await send(x.body);assert.equal(failed.status,503);assert.equal(failed.retry,'5');assert.deepEqual(failed.body,{error:'EVENT_INBOX_UNAVAILABLE'});assert.equal(await eventRow(x.event.eventId),undefined); }
      finally { await admin.query('DROP TRIGGER fail_inbox ON payment_events');await admin.query('DROP FUNCTION fail_inbox()'); }
      acknowledged(await send(x.body,{url:urls[1]}));
      const y=await fixture();let inject=true;
      const faultPool={connect:async()=>{
        const client=await pools[0].connect();return {release:e=>client.release(e),query:async(sql,values)=>{
          const result=await client.query(sql,values);
          if(sql==='COMMIT'&&inject){inject=false;const error=new Error('fixture lost acknowledgement');error.code='08006';throw error;}return result;
        }};
      }};
      const faultUrl=await api(faultPool), failed=await send(y.body,{url:faultUrl});assert.equal(failed.status,503);
      assert.equal((await eventRow(y.event.eventId)).status,'RECEIVED');acknowledged(await send(y.body,{url:urls[1]}));
      assert.equal((await pools[0].query('SELECT count(*)::int AS n FROM payment_events WHERE provider_event_id=$1',[y.event.eventId])).rows[0].n,1);
      assert.equal((await pools[0].query('SELECT status FROM payment_attempts WHERE id=$1',[y.pay.id])).rows[0].status,'CREATED');
    });
  } finally {
    for(const server of servers) await new Promise(resolve=>server.close(resolve));
    for(const pool of pools) await pool.end();
    if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^reliability_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}
    await adminPool.end();
  }
});
