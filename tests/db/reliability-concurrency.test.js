import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';
import { claimIdempotency, completeIdempotency } from '../../apps/api/src/reliability/idempotency.js';
import { claimOutbox, acknowledgeOutbox } from '../../apps/api/src/reliability/outbox.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('idempotency and outbox across independent PostgreSQL connections',async t=>{
  const pool=createPool(readConfig().DATABASE_URL); let admin,a,b,schema;
  try {
    admin=await pool.connect(); await admin.query('BEGIN');
    schema=await installReliabilitySchema(admin,'reliability_concurrent');
    const f=await paymentFixture(admin);
    for(let i=0;i<2;i++){
      const pay=await f.attempt(await f.reservation());
      await admin.query('INSERT INTO outbox_events (kind,payment_attempt_id,operation_key) VALUES ($1,$2,$3)',['PAYMENT_CREATE',pay.id,pay.request_key]);
    }
    await admin.query('COMMIT');
    a=await pool.connect(); b=await pool.connect();
    for(const db of [a,b]) await db.query('SELECT set_config($1,$2,false)',['search_path',`${schema}, public`]);
    const pidA=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pidB=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const hash=createHash('sha256').update('normalized-test-request').digest();
    const key=()=>({userId:f.user,operation:'reservation.create',key:randomUUID(),requestHash:hash});
    async function waitForDatabaseWait(){
      for(let i=0;i<50;i++){
        const result=await admin.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS waiting',[pidA,pidB]);
        if(result.rows[0].waiting) return;
        await delay(10);
      }
      assert.fail('Second connection did not wait for the uncommitted claim');
    }
    async function cleanupPair(pending){
      await a.query('ROLLBACK').catch(()=>{});
      if(pending) await pending;
      await b.query('ROLLBACK').catch(()=>{});
    }
    await t.test('concurrent duplicate waits for commit and replays one saved response',async()=>{
      let pending;
      try {
        await a.query('BEGIN'); await b.query('BEGIN'); const input=key();
        assert.equal((await claimIdempotency(a,input)).kind,'claimed');
        pending=claimIdempotency(b,input).then(value=>({value}),error=>({error}));
        await waitForDatabaseWait();
        const body={reservationId:randomUUID(),status:'ACTIVE'};
        await completeIdempotency(a,input,201,body); await a.query('COMMIT');
        const outcome=await pending; if(outcome.error) throw outcome.error;
        assert.deepEqual(outcome.value,{kind:'replay',status:201,body}); await b.query('COMMIT');
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1',[input.key])).rows[0].n,1);
      } finally {await cleanupPair(pending);}
    });
    await t.test('rollback of the first claim lets the waiting connection become the winner',async()=>{
      let pending;
      try {
        await a.query('BEGIN'); await b.query('BEGIN'); const input=key();
        await claimIdempotency(a,input);
        pending=claimIdempotency(b,input).then(value=>({value}),error=>({error}));
        await waitForDatabaseWait(); await a.query('ROLLBACK');
        const outcome=await pending; if(outcome.error) throw outcome.error;
        assert.deepEqual(outcome.value,{kind:'claimed'});
        await completeIdempotency(b,input,202,{accepted:true}); await b.query('COMMIT');
      } finally {await cleanupPair(pending);}
    });
    await t.test('two workers skip each other\'s locked work and keep separate leases',async()=>{
      try {
        await a.query('BEGIN'); await b.query('BEGIN');
        const [first]=await claimOutbox(a,{workerId:'worker-a',batchSize:1});
        const [second]=await claimOutbox(b,{workerId:'worker-b',batchSize:1});
        assert.ok(first); assert.ok(second); assert.notEqual(first.id,second.id);
        await a.query('COMMIT'); await b.query('COMMIT');
        assert.equal(await acknowledgeOutbox(a,first.id,second.lease_token),false);
        assert.equal(await acknowledgeOutbox(a,first.id,first.lease_token),true);
        assert.equal(await acknowledgeOutbox(b,second.id,second.lease_token),true);
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM outbox_events WHERE status='SUCCEEDED'")).rows[0].n,2);
      } finally {await cleanupPair();}
    });
  } finally {
    for(const db of [a,b]) if(db){await db.query('ROLLBACK').catch(()=>{});db.release();}
    try {
      if(admin){
        await admin.query('ROLLBACK').catch(()=>{});
        // Only this generated test schema is dropped; no application schema,
        // database, Docker volume or other project is reset.
        if(schema){assert.match(schema,/^reliability_concurrent_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}
      }
    } finally {if(admin)admin.release();await pool.end();}
  }
});
