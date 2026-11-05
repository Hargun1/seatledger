import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';
import { paymentFixture } from '../helpers/payment-fixture.js';

test('simulated payment/event/refund storage integrity (real PostgreSQL)', async t => {
  const pool = createPool(readConfig().DATABASE_URL);
  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    const f = await paymentFixture(db);
    async function check(name, work) {
      await t.test(name, async () => {
        await db.query('SAVEPOINT case_scope');
        try { await work(); }
        finally { await db.query('ROLLBACK TO SAVEPOINT case_scope'); await db.query('RELEASE SAVEPOINT case_scope'); }
      });
    }
    async function rejected(sql, values, code = '23514', constraint) {
      await db.query('SAVEPOINT invalid_write');
      try { await assert.rejects(db.query(sql, values), e => e.code === code && (!constraint || e.constraint === constraint)); }
      finally { await db.query('ROLLBACK TO SAVEPOINT invalid_write'); await db.query('RELEASE SAVEPOINT invalid_write'); }
    }
    const flush = () => db.query('SET CONSTRAINTS ALL IMMEDIATE');
    const insertAttempt = 'INSERT INTO payment_attempts (reservation_id,user_id,show_id,amount_minor,currency,provider) VALUES ($1,$2,$3,$4,$5,$6)';

    await check('attempt money, currency and ownership must match the reservation', async () => {
      const res = await f.reservation();
      for (const values of [[f.user,f.show,1,'INR'],[f.user,f.show,75000,'USD'],[randomUUID(),f.show,75000,'INR'],[f.user,randomUUID(),75000,'INR']]) {
        await rejected(insertAttempt, [res.id,...values,'simulated'], '23503', 'payment_attempts_reservation_fk');
      }
    });
    await check('only simulated providers and CREATED initial attempts are accepted', async () => {
      const res = await f.reservation();
      await rejected(insertAttempt, [res.id,f.user,f.show,75000,'INR','live']);
      await rejected('INSERT INTO payment_attempts (reservation_id,user_id,show_id,amount_minor,currency,status) VALUES ($1,$2,$3,$4,$5,$6)', [res.id,f.user,f.show,75000,'INR','SUCCEEDED'], '23514', 'payment_attempts_initial_state');
    });
    await check('provider payment IDs and stable request keys cannot be duplicated or rewritten', async () => {
      const res = await f.reservation(), pay = await f.attempt(res);
      await rejected('INSERT INTO payment_attempts (reservation_id,user_id,show_id,amount_minor,currency,provider_payment_id) VALUES ($1,$2,$3,$4,$5,$6)', [res.id,f.user,f.show,75000,'INR',pay.provider_payment_id], '23505');
      await rejected('INSERT INTO payment_attempts (reservation_id,user_id,show_id,amount_minor,currency,request_key) VALUES ($1,$2,$3,$4,$5,$6)', [res.id,f.user,f.show,75000,'INR',pay.request_key], '23505');
      await rejected('UPDATE payment_attempts SET request_key=$1 WHERE id=$2', [randomUUID(),pay.id], '23514', 'payment_attempts_immutable');
      await rejected('UPDATE payment_attempts SET provider_payment_id=$1 WHERE id=$2', ['changed',pay.id], '23514', 'payment_attempts_immutable');
      await flush();
    });
    await check('success requires an explicit destination and a durable compensation request', async () => {
      const pay = await f.attempt(await f.reservation());
      await rejected('UPDATE payment_attempts SET status=$1 WHERE id=$2', ['SUCCEEDED',pay.id], '23514', 'payment_attempts_outcome');
      await f.capture(pay);
      await rejected('SET CONSTRAINTS payment_attempts_accounted IMMEDIATE', [], '23514', 'payment_attempts_accounted');
      await f.refund(pay);
      await flush();
    });
    await check('a late success observation can supersede FAILED without later regression', async () => {
      const pay = await f.attempt(await f.reservation());
      await db.query('UPDATE payment_attempts SET status=$1 WHERE id=$2', ['FAILED',pay.id]);
      await f.capture(pay);
      await f.refund(pay);
      for (const status of ['FAILED','PENDING','CREATED']) await rejected('UPDATE payment_attempts SET status=$1 WHERE id=$2', [status,pay.id], '23514', 'payment_attempts_transition');
      await flush();
    });
    await check('two captured attempts cannot both fund one booking; the extra capture can be compensated', async () => {
      const res = await f.reservation(), id = await f.booking(res);
      const first = await f.attempt(res), extra = await f.attempt(res);
      await f.capture(first,id);
      await rejected('UPDATE payment_attempts SET status=$1,resolution=$2,booking_id=$3,succeeded_at=clock_timestamp() WHERE id=$4', ['SUCCEEDED','BOOKED',id,extra.id], '23505', 'payment_attempts_booking_funding_unique');
      await f.capture(extra);
      await f.refund(extra,'DUPLICATE_PAYMENT');
      await flush();
    });
    await check('a successful attempt cannot claim another reservation\'s booking', async () => {
      const res = await f.reservation(), id = await f.booking(res);
      const other = await f.attempt(await f.reservation());
      await rejected('UPDATE payment_attempts SET status=$1,resolution=$2,booking_id=$3,succeeded_at=clock_timestamp() WHERE id=$4', ['SUCCEEDED','BOOKED',id,other.id], '23503', 'payment_attempts_booking_fk');
      await flush();
    });
    await check('event identity rejects duplicate records and event evidence is immutable', async () => {
      const pay = await f.attempt(await f.reservation());
      const event = await f.eventRecord(pay);
      await rejected('INSERT INTO payment_events (provider_event_id,payment_attempt_id,provider_payment_id,kind,amount_minor,currency,payload_hash,verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())', [event.provider_event_id,pay.id,pay.provider_payment_id,'PAYMENT_SUCCEEDED',75000,'INR',event.payload_hash], '23505');
      await rejected('UPDATE payment_events SET amount_minor=1 WHERE id=$1', [event.id], '23514', 'payment_events_immutable');
      await db.query('UPDATE payment_events SET status=$1,processed_at=clock_timestamp() WHERE id=$2', ['PROCESSED',event.id]);
      await rejected('UPDATE payment_events SET status=$1,processed_at=NULL WHERE id=$2', ['RECEIVED',event.id], '23514', 'payment_events_immutable');
      await flush();
    });
    await check('rejected callback evidence may retain a mismatched amount without changing the attempt', async () => {
      const pay = await f.attempt(await f.reservation());
      const event = await f.eventRecord(pay, { amount: 1, rejected: true });
      assert.equal(event.status,'REJECTED');
      assert.equal((await db.query('SELECT amount_minor,status FROM payment_attempts WHERE id=$1', [pay.id])).rows[0].amount_minor,'75000');
      assert.equal((await db.query('SELECT status FROM payment_attempts WHERE id=$1', [pay.id])).rows[0].status,'CREATED');
      await flush();
    });
    await check('refunds require a capture and the original full amount/currency', async () => {
      const pay = await f.attempt(await f.reservation());
      await rejected('INSERT INTO refunds (payment_attempt_id,amount_minor,currency,reason) VALUES ($1,$2,$3,$4)', [pay.id,1,'INR','HOLD_EXPIRED'], '23503', 'refunds_attempt_fk');
      await rejected('INSERT INTO refunds (payment_attempt_id,amount_minor,currency,reason) VALUES ($1,$2,$3,$4)', [pay.id,75000,'USD','HOLD_EXPIRED'], '23503', 'refunds_attempt_fk');
      await f.refund(pay);
      await rejected('SET CONSTRAINTS refunds_eligible IMMEDIATE', [], '23514', 'refunds_eligible');
    });
    await check('one full refund per attempt prevents duplicate compensation requests', async () => {
      const pay = await f.attempt(await f.reservation());
      await f.capture(pay);
      await f.refund(pay);
      await rejected('INSERT INTO refunds (payment_attempt_id,amount_minor,currency,reason) VALUES ($1,$2,$3,$4)', [pay.id,75000,'INR','HOLD_EXPIRED'], '23505');
      await flush();
    });
    await check('failed refund retries reuse their request key and cannot regress after success', async () => {
      const pay = await f.attempt(await f.reservation());
      await f.capture(pay);
      const refund = await f.refund(pay);
      for (const status of ['PROCESSING','RETRYABLE_FAILURE','PROCESSING']) await db.query('UPDATE refunds SET status=$1,processing_attempts=processing_attempts+1 WHERE id=$2', [status,refund.id]);
      await rejected('UPDATE refunds SET status=$1 WHERE id=$2', ['SUCCEEDED',refund.id], '23514', 'refunds_completion');
      await db.query('UPDATE refunds SET status=$1,provider_refund_id=$2,completed_at=clock_timestamp() WHERE id=$3', ['SUCCEEDED',`sim_refund_${refund.id}`,refund.id]);
      assert.equal((await db.query('SELECT request_key FROM refunds WHERE id=$1', [refund.id])).rows[0].request_key,refund.request_key);
      await rejected('UPDATE refunds SET status=$1 WHERE id=$2', ['PROCESSING',refund.id], '23514', 'refunds_transition');
      await rejected('UPDATE refunds SET request_key=$1 WHERE id=$2', [randomUUID(),refund.id], '23514', 'refunds_immutable');
      await flush();
    });
    await check('booking-cancellation refunds require a cancelled booking, separate from capture status', async () => {
      const res = await f.reservation(), id = await f.booking(res), pay = await f.attempt(res);
      await f.capture(pay,id);
      await f.refund(pay,'CUSTOMER_CANCELLED');
      await rejected('SET CONSTRAINTS refunds_eligible IMMEDIATE', [], '23514', 'refunds_eligible');
      await db.query('UPDATE bookings SET status=$1,cancelled_at=clock_timestamp() WHERE id=$2', ['CANCELLED',id]);
      await flush();
      assert.equal((await db.query('SELECT status FROM payment_attempts WHERE id=$1', [pay.id])).rows[0].status,'SUCCEEDED');
    });
    await check('payment, event and refund evidence cannot be deleted', async () => {
      const pay = await f.attempt(await f.reservation());
      const event = await f.eventRecord(pay);
      await f.capture(pay);
      const refund = await f.refund(pay);
      await rejected('DELETE FROM payment_attempts WHERE id=$1', [pay.id], '23514', 'payment_attempts_immutable');
      await rejected('DELETE FROM payment_events WHERE id=$1', [event.id], '23514', 'payment_events_immutable');
      await rejected('DELETE FROM refunds WHERE id=$1', [refund.id], '23514', 'refunds_immutable');
      await flush();
    });
    await check('unknown payment evidence is retained only with an explicit rejection result', async () => {
      const sql = `INSERT INTO payment_events
        (provider_event_id,provider_payment_id,kind,amount_minor,currency,payload_hash,verified_at,received_at,status,processed_at,rejection_code)
        VALUES ($1,$2,'PAYMENT_SUCCEEDED',1,'INR',$3,statement_timestamp(),statement_timestamp(),$4,
          CASE WHEN $4='REJECTED' THEN clock_timestamp() ELSE NULL END,
          CASE WHEN $4='REJECTED' THEN 'UNKNOWN_PAYMENT' ELSE NULL END) RETURNING *`;
      const hash = Buffer.alloc(32,1);
      await rejected(sql, [randomUUID(),'unknown',hash,'RECEIVED'], '23514', 'payment_events_processing_shape');
      const event = (await db.query(sql, [randomUUID(),'unknown',hash,'REJECTED'])).rows[0];
      assert.equal(event.payment_attempt_id,null);
      assert.equal(event.rejection_code,'UNKNOWN_PAYMENT');
      await flush();
    });
    await check('compensation cannot use an unrelated booking-cancellation reason', async () => {
      const pay = await f.attempt(await f.reservation());
      await f.capture(pay);
      await f.refund(pay,'CUSTOMER_CANCELLED');
      await rejected('SET CONSTRAINTS refunds_eligible IMMEDIATE', [], '23514', 'refunds_eligible');
    });
    await check('refund request keys and provider refund IDs are unique across attempts', async () => {
      const first = await f.attempt(await f.reservation()), second = await f.attempt(await f.reservation());
      await f.capture(first); await f.capture(second);
      const a = await f.refund(first), b = await f.refund(second);
      await db.query('UPDATE refunds SET provider_refund_id=$1 WHERE id=$2', ['sim_shared',a.id]);
      await rejected('UPDATE refunds SET provider_refund_id=$1 WHERE id=$2', ['sim_shared',b.id], '23505');
      const third = await f.attempt(await f.reservation());
      await f.capture(third);
      await rejected('INSERT INTO refunds (payment_attempt_id,amount_minor,currency,reason,request_key) VALUES ($1,$2,$3,$4,$5)', [third.id,75000,'INR','HOLD_EXPIRED',a.request_key], '23505');
      await f.refund(third);
      await flush();
    });
  } finally {
    try { if (db) { try { await db.query('ROLLBACK'); } finally { db.release(); } } }
    finally { await pool.end(); }
  }
});
