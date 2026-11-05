import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';
import { claimIdempotency, completeIdempotency } from '../../apps/api/src/reliability/idempotency.js';
import { claimOutbox, acknowledgeOutbox, failOutbox } from '../../apps/api/src/reliability/outbox.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('reliability records and helpers (real PostgreSQL)', async t => {
  const pool = createPool(readConfig().DATABASE_URL);
  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    await installReliabilitySchema(db);
    const f = await paymentFixture(db);
    const hash = createHash('sha256').update('{"seat":"A1"}').digest();
    const input = () => ({ userId:f.user,operation:'reservation.create',key:randomUUID(),requestHash:hash });
    async function check(name, work) {
      await t.test(name, async () => {
        await db.query('SAVEPOINT case_scope');
        try { await work(); }
        finally { await db.query('ROLLBACK TO SAVEPOINT case_scope'); await db.query('RELEASE SAVEPOINT case_scope'); }
      });
    }
    async function rejected(sql, values, code='23514', constraint) {
      await db.query('SAVEPOINT invalid_write');
      try { await assert.rejects(db.query(sql,values), e=>e.code===code && (!constraint || e.constraint===constraint)); }
      finally { await db.query('ROLLBACK TO SAVEPOINT invalid_write'); await db.query('RELEASE SAVEPOINT invalid_write'); }
    }
    const flush = () => db.query('SET CONSTRAINTS ALL IMMEDIATE');
    async function enqueue({ maxAttempts=8, future=false }={}) {
      const pay = await f.attempt(await f.reservation());
      return (await db.query(`INSERT INTO outbox_events (kind,payment_attempt_id,operation_key,payload,max_attempts,next_attempt_at)
        VALUES ('PAYMENT_CREATE',$1,$2,$3::jsonb,$4,clock_timestamp()+($5::integer*interval '1 hour')) RETURNING *`,
      [pay.id,pay.request_key,JSON.stringify({ scenario:'success' }),maxAttempts,future?1:0])).rows[0];
    }

    await check('completed request replays its exact saved status/body; payload mismatch conflicts', async()=>{
      const key=input(), body={ reservationId:randomUUID(), status:'ACTIVE' };
      assert.deepEqual(await claimIdempotency(db,key),{kind:'claimed'});
      await completeIdempotency(db,key,201,body);
      assert.deepEqual(await claimIdempotency(db,key),{kind:'replay',status:201,body});
      assert.deepEqual(await claimIdempotency(db,{...key,requestHash:Buffer.alloc(32,2)}),{kind:'conflict'});
      await flush();
    });
    await check('keys are scoped by user and operation', async()=>{
      const key=input(), otherUser=randomUUID();
      await db.query('INSERT INTO users (id,email,display_name,status) VALUES ($1,$2,$3,$4)',[otherUser,`${otherUser}@test.invalid`,'Other','DISABLED']);
      for(const scope of [key,{...key,operation:'payment.create'},{...key,userId:otherUser}]) {
        assert.equal((await claimIdempotency(db,scope)).kind,'claimed');
        await completeIdempotency(db,scope,202,{ accepted:true });
      }
      assert.equal((await db.query('SELECT count(*)::int AS n FROM idempotency_keys')).rows[0].n,3);
      await flush();
    });
    await check('unfinished claims cannot commit and completion requires the matching hash', async()=>{
      const key=input(); await claimIdempotency(db,key);
      await rejected('SET CONSTRAINTS idempotency_complete IMMEDIATE',[],'23514','idempotency_complete');
      await assert.rejects(completeIdempotency(db,{...key,requestHash:Buffer.alloc(32,3)},201,{}),/not in progress/);
      await assert.rejects(claimIdempotency(db,key),/already in progress/);
      await completeIdempotency(db,key,201,{}); await flush();
    });
    await check('saved identity/result are immutable and response storage is bounded',async()=>{
      const key=input(); await claimIdempotency(db,key);
      const sql="UPDATE idempotency_keys SET status='COMPLETED',response_status=$4,response_body=$5::jsonb,completed_at=clock_timestamp() WHERE user_id=$1 AND operation=$2 AND key=$3";
      for(const [status,body] of [[500,{}],[201,[]],[201,{data:'x'.repeat(33000)}]]) await rejected(sql,[key.userId,key.operation,key.key,status,JSON.stringify(body)],'23514','idempotency_response_shape');
      await completeIdempotency(db,key,201,{ok:true});
      await rejected('UPDATE idempotency_keys SET response_body=$4::jsonb WHERE user_id=$1 AND operation=$2 AND key=$3',[key.userId,key.operation,key.key,'{}'],'23514','idempotency_immutable');
      await rejected('DELETE FROM idempotency_keys WHERE user_id=$1',[key.userId],'23514','idempotency_immutable');
      await flush();
    });
    await check('retention timestamp does not silently reuse a prior key',async()=>{
      const key=input();
      await db.query(`INSERT INTO idempotency_keys (user_id,operation,key,request_hash,created_at,retention_until)
        VALUES ($1,$2,$3,$4,statement_timestamp()-interval '2 days',statement_timestamp()-interval '1 day')`,[key.userId,key.operation,key.key,key.requestHash]);
      await completeIdempotency(db,key,201,{original:true});
      assert.equal((await claimIdempotency(db,key)).kind,'replay'); await flush();
    });
    await check('outbox identity must match its typed target and original provider request key',async()=>{
      const job=await enqueue();
      await rejected('INSERT INTO outbox_events (kind,payment_attempt_id,operation_key) VALUES ($1,$2,$3)',['PAYMENT_CREATE',job.payment_attempt_id,randomUUID()],'23505');
      const other=await f.attempt(await f.reservation());
      await rejected('INSERT INTO outbox_events (kind,payment_attempt_id,operation_key) VALUES ($1,$2,$3)',['PAYMENT_CREATE',other.id,randomUUID()],'23503','outbox_payment_request_fk');
      await rejected('INSERT INTO outbox_events (kind,operation_key) VALUES ($1,$2)',['PAYMENT_CREATE',randomUUID()],'23514','outbox_target_shape');
      await rejected('UPDATE outbox_events SET payload=$1::jsonb WHERE id=$2',['{}',job.id],'23514','outbox_immutable'); await flush();
    });
    await check('a refund job references the refund request key, not its payment key',async()=>{
      const pay=await f.attempt(await f.reservation()); await f.capture(pay); const refund=await f.refund(pay);
      await rejected('INSERT INTO outbox_events (kind,refund_id,operation_key) VALUES ($1,$2,$3)',['REFUND_CREATE',refund.id,pay.request_key],'23503','outbox_refund_request_fk');
      await db.query('INSERT INTO outbox_events (kind,refund_id,operation_key) VALUES ($1,$2,$3)',['REFUND_CREATE',refund.id,refund.request_key]); await flush();
    });
    await check('claims are bounded, scheduled and fenced by a live lease',async()=>{
      const job=await enqueue(); await enqueue({future:true});
      const claims=await claimOutbox(db,{workerId:'worker-a',batchSize:1});
      assert.equal(claims.length,1); assert.equal(claims[0].id,job.id);
      assert.equal(await acknowledgeOutbox(db,job.id,randomUUID()),false);
      assert.equal(await acknowledgeOutbox(db,job.id,claims[0].lease_token),true);
      assert.equal(await acknowledgeOutbox(db,job.id,claims[0].lease_token),false);
      assert.equal((await claimOutbox(db,{workerId:'worker-b'})).length,0); await flush();
    });
    await check('retry reuses the operation identity and dead letters can be explicitly requeued',async()=>{
      const job=await enqueue({maxAttempts:2});
      const [a]=await claimOutbox(db,{workerId:'worker-a'});
      assert.equal(await failOutbox(db,job.id,a.lease_token,{code:'SIM_TIMEOUT',delaySeconds:0}),true);
      const [b]=await claimOutbox(db,{workerId:'worker-b'});
      assert.equal(b.operation_key,job.operation_key); assert.notEqual(a.lease_token,b.lease_token);
      assert.equal(await acknowledgeOutbox(db,job.id,a.lease_token),false);
      await failOutbox(db,job.id,b.lease_token,{code:'SIM_TIMEOUT',delaySeconds:0});
      assert.equal((await db.query('SELECT status FROM outbox_events WHERE id=$1',[job.id])).rows[0].status,'DEAD_LETTER');
      await db.query("UPDATE outbox_events SET status='RETRY_WAIT',max_attempts=3,manual_requeues=manual_requeues+1,completed_at=NULL,next_attempt_at=clock_timestamp() WHERE id=$1",[job.id]);
      const [c]=await claimOutbox(db,{workerId:'worker-c'}); assert.equal(c.attempt_count,3);
      assert.equal(await acknowledgeOutbox(db,job.id,c.lease_token),true); await flush();
    });
    await check('an expired lease can be reclaimed and the old worker cannot acknowledge it',async()=>{
      const job=await enqueue(); const [a]=await claimOutbox(db,{workerId:'old',leaseSeconds:1});
      await delay(1100);
      assert.equal(await acknowledgeOutbox(db,job.id,a.lease_token),false);
      const [b]=await claimOutbox(db,{workerId:'new'}); assert.notEqual(a.lease_token,b.lease_token); assert.equal(b.attempt_count,2);
      assert.equal(await acknowledgeOutbox(db,job.id,a.lease_token),false);
      assert.equal(await acknowledgeOutbox(db,job.id,b.lease_token),true); await flush();
    });
    await check('an abandoned final lease becomes a visible dead letter',async()=>{
      const job=await enqueue({maxAttempts:1}); await claimOutbox(db,{workerId:'crashed',leaseSeconds:1}); await delay(1100);
      assert.equal((await claimOutbox(db,{workerId:'sweeper'})).length,0);
      assert.deepEqual((await db.query('SELECT status,last_error_code FROM outbox_events WHERE id=$1',[job.id])).rows[0],{status:'DEAD_LETTER',last_error_code:'LEASE_EXHAUSTED'}); await flush();
    });
    await check('audit records enforce actor shape, deduplicate actions and reject rewrites',async()=>{
      const op=randomUUID(), entity=randomUUID();
      const sql='INSERT INTO audit_events (operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)';
      const args=[op,'USER',f.user,'reservation.created','reservation',entity,'{"source":"test"}'];
      await db.query(sql,args); await rejected(sql,args,'23505');
      await rejected(sql,[randomUUID(),'USER',null,'reservation.created','reservation',entity,'{}']);
      await rejected('UPDATE audit_events SET metadata=$1::jsonb WHERE operation_id=$2',['{}',op],'23514','append_only_record');
      await rejected('DELETE FROM audit_events WHERE operation_id=$1',[op],'23514','append_only_record'); await flush();
    });
    await check('check-in storage rejects duplicates and mismatched ticket/show/organizer links',async()=>{
      const booking=await f.booking(await f.reservation());
      const item=(await db.query('SELECT id FROM booking_items WHERE booking_id=$1',[booking])).rows[0].id;
      const org=(await db.query('SELECT organizer_id FROM shows WHERE id=$1',[f.show])).rows[0].organizer_id;
      const sql='INSERT INTO ticket_checkins (booking_item_id,show_id,organizer_id,checked_by,request_key) VALUES ($1,$2,$3,$4,$5)';
      await db.query(sql,[item,f.show,org,f.user,randomUUID()]);
      await rejected(sql,[item,f.show,org,f.user,randomUUID()],'23505');
      await rejected('UPDATE ticket_checkins SET checked_by=$1 WHERE booking_item_id=$2',[f.user,item],'23514','append_only_record');
      // A second item allows checking FK failures rather than duplicate PKs.
      const second=await f.booking(await f.reservation());
      const otherItem=(await db.query('SELECT id FROM booking_items WHERE booking_id=$1',[second])).rows[0].id;
      await rejected(sql,[otherItem,randomUUID(),org,f.user,randomUUID()],'23503');
      const otherOrg=randomUUID(); await db.query('INSERT INTO organizers (id,name) VALUES ($1,$2)',[otherOrg,'Other']);
      await rejected(sql,[otherItem,f.show,otherOrg,f.user,randomUUID()],'23503','checkins_show_owner_fk'); await flush();
    });
    await check('request response, payment work and audit can roll back as one unit',async()=>{
      await db.query('SAVEPOINT request_unit');
      const key=input(); await claimIdempotency(db,key); const job=await enqueue(); const op=randomUUID();
      await db.query('INSERT INTO audit_events (operation_id,actor_kind,action,entity_type,entity_id) VALUES ($1,$2,$3,$4,$5)',[op,'SYSTEM','payment.queued','payment',job.payment_attempt_id]);
      await completeIdempotency(db,key,202,{paymentAttemptId:job.payment_attempt_id}); await flush();
      await db.query('ROLLBACK TO SAVEPOINT request_unit'); await db.query('RELEASE SAVEPOINT request_unit');
      assert.equal((await db.query('SELECT id FROM outbox_events WHERE id=$1',[job.id])).rowCount,0);
      assert.equal((await db.query('SELECT key FROM idempotency_keys WHERE key=$1',[key.key])).rowCount,0);
      assert.equal((await db.query('SELECT id FROM audit_events WHERE operation_id=$1',[op])).rowCount,0);
    });
  } finally {
    try { if(db) { try { await db.query('ROLLBACK'); } finally { db.release(); } } }
    finally { await pool.end(); }
  }
});
