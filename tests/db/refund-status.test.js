import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { claimOutbox, failOutbox, acknowledgeOutbox } from '../../apps/api/src/reliability/outbox.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { readCustomerRefund } from '../../apps/web/src/payments/refund.js';

test('owned refund HTTP snapshots show missing, queued, retrying, dead-letter, inconsistent and completed facts without side effects', { timeout: 15000 }, async () => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original);
  let admin, schema, pool, server;
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin, 'auth_test');
    const f = await paymentFixture(admin), reservation = await f.reservation(), pay = await f.attempt(reservation);
    await admin.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1", [f.user]);
    const token = newToken(), secret = 'ab'.repeat(32);
    await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [f.user, digest(token), digest(csrfFor(token,secret))]);
    await admin.query('COMMIT'); const url = new URL(original); url.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(url.toString());
    server = createApp({ pool, config: { NODE_ENV: 'test', AUTH_SECRET: secret, PUBLIC_ORIGIN: 'http://127.0.0.1' }, logger: { info(){}, error(){} } }).listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    const base = `http://127.0.0.1:${server.address().port}`, path = `/api/payments/${pay.id}/refund`;
    const fetchImpl = (path, options) => fetch(base+path, { ...options, headers: { Cookie: `seatledger_session=${token}` } });
    const read = () => readCustomerRefund({ payment: { id: pay.id, amountMinor: 75000, currency: 'INR' }, fetchImpl });
    assert.equal((await read()).refund, null);
    assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetchImpl('/api/payments/'+randomUUID()+'/refund',{})).status,404);
    assert.equal((await fetchImpl('/api/payments/bad/refund',{})).status,404);
    assert.equal((await fetchImpl(path+'?userId='+f.user,{})).status,400);
    const foreign = (await pool.query("INSERT INTO users(email,display_name,status,password_hash) VALUES($1,'Other','ACTIVE','fixture-not-for-login') RETURNING id", [randomUUID()+'@test.invalid'])).rows[0].id;
    const otherToken = newToken();
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [foreign,digest(otherToken),digest(csrfFor(otherToken,secret))]);
    assert.equal((await fetch(base+path,{headers:{Cookie:`seatledger_session=${otherToken}`}})).status,404);
    const response = await fetchImpl(path,{}); assert.equal(response.headers.get('cache-control'),'no-store');
    let refund;
    // Financial setup below uses one transaction so deferred compensation checks hold.
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query("UPDATE payment_attempts SET status='SUCCEEDED',resolution='REFUND_REQUIRED',succeeded_at=clock_timestamp() WHERE id=$1",[pay.id]);
      refund = (await setup.query("INSERT INTO refunds(payment_attempt_id,amount_minor,currency,reason) VALUES($1,75000,'INR','INVENTORY_LOST') RETURNING *",[pay.id])).rows[0];
      await setup.query('COMMIT');
    } catch(error) { await setup.query('ROLLBACK'); throw error; } finally { setup.release(); }
    assert.equal((await read()).refund.progress,'REVIEW_REQUIRED','A missing job cannot promise processing');
    await pool.query("INSERT INTO outbox_events(kind,refund_id,operation_key) VALUES('REFUND_CREATE',$1,$2)",[refund.id,refund.request_key]);
    assert.equal((await read()).refund.progress,'QUEUED');
    const claim = async () => (await claimOutbox(pool,{workerId:'refund-status-test',batchSize:1,kinds:['REFUND_CREATE']}))[0];
    let lease = await claim(); assert.equal((await read()).refund.progress,'PROCESSING');
    await failOutbox(pool,lease.id,lease.lease_token,{code:'PRIVATE_INTERNAL_DETAIL',delaySeconds:0});
    assert.equal((await read()).refund.progress,'RETRYING');
    lease = await claim(); await failOutbox(pool,lease.id,lease.lease_token,{code:'PERMANENT',retryable:false});
    assert.equal((await read()).refund.progress,'REVIEW_REQUIRED');
    // A separate SQL-only captured attempt exercises exact successful-job pairing.
    const complete = await pool.connect(), secondToken = newToken(); let secondPay, secondRefund, exhaustedPay, exhaustedRefund;
    try {
      await complete.query('BEGIN'); const g = await paymentFixture(complete); const r = await g.reservation();
      secondPay = await g.attempt(r); await g.capture(secondPay); secondRefund = await g.refund(secondPay);
      // Give this fixture's owner a real session; never alter immutable payment ownership.
      await complete.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1",[g.user]);
      await complete.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[g.user,digest(secondToken),digest(csrfFor(secondToken,secret))]);
      await complete.query("INSERT INTO outbox_events(kind,refund_id,operation_key) VALUES('REFUND_CREATE',$1,$2)",[secondRefund.id,secondRefund.request_key]);
      const exhaustedReservation = await g.reservation(); exhaustedPay = await g.attempt(exhaustedReservation);
      await g.capture(exhaustedPay); exhaustedRefund = await g.refund(exhaustedPay);
      await complete.query("INSERT INTO outbox_events(kind,refund_id,operation_key,max_attempts) VALUES('REFUND_CREATE',$1,$2,1)",[exhaustedRefund.id,exhaustedRefund.request_key]);
      await complete.query('COMMIT');
    } catch(error) { await complete.query('ROLLBACK'); throw error; } finally { complete.release(); }
    const secondRead = async () => readCustomerRefund({ payment: { id: secondPay.id, amountMinor: 75000, currency: 'INR' },
      fetchImpl: (path,options) => fetch(base+path,{...options,headers:{Cookie:`seatledger_session=${secondToken}`}}) });
    lease = await claim(); assert.equal(lease.refund_id,secondRefund.id);
    assert.equal(await acknowledgeOutbox(pool,lease.id,lease.lease_token),true);
    assert.equal((await secondRead()).refund.progress,'REVIEW_REQUIRED','Job success alone is not refund completion');
    await pool.query("UPDATE refunds SET status='PROCESSING',processing_attempts=1 WHERE id=$1",[secondRefund.id]);
    await pool.query("UPDATE refunds SET status='SUCCEEDED',completed_at=clock_timestamp(),provider_refund_id=$2 WHERE id=$1",[secondRefund.id,'sim_refund_'+randomUUID()]);
    const done = await secondRead(); assert.equal(done.refund.progress,'COMPLETED'); assert.ok(done.refund.completedAt);
    const last = (await claimOutbox(pool,{workerId:'abandoned-status-test',batchSize:1,leaseSeconds:1,kinds:['REFUND_CREATE']}))[0];
    assert.equal(last.refund_id,exhaustedRefund.id);
    await pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (lease_expires_at-clock_timestamp())))+0.02) FROM outbox_events WHERE id=$1",[last.id]);
    const exhausted = await readCustomerRefund({payment:{id:exhaustedPay.id,amountMinor:75000,currency:'INR'},
      fetchImpl:(path,options)=>fetch(base+path,{...options,headers:{Cookie:`seatledger_session=${secondToken}`}})});
    assert.equal(exhausted.refund.progress,'REVIEW_REQUIRED','Final expired lease needs review even before a sweeper runs');
    assert.equal((await pool.query('SELECT status FROM outbox_events WHERE id=$1',[last.id])).rows[0].status,'PROCESSING','GET never sweeps jobs');
    const before = (await pool.query('SELECT status,attempt_count FROM outbox_events ORDER BY id')).rows;
    for(let i=0;i<3;i++) await read();
    assert.deepEqual((await pool.query('SELECT status,attempt_count FROM outbox_events ORDER BY id')).rows,before);
    const serialized = JSON.stringify(await read());
    for(const value of ['PRIVATE_INTERNAL_DETAIL','request_key','lease_token','provider_refund_id','claimed_by']) assert.ok(!serialized.includes(value));
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} if(pool)await pool.end();
    if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();
  }
});
