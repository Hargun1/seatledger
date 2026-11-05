import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { decodeHistoryCursor } from '../../apps/api/src/reliability/history-cursor.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { readAccountPayments, paymentHistoryCheckoutPath } from '../../apps/web/src/payments/history.js';

test('owned account payments: tied-time paging, all outcomes, catalogue drift, authorization and GET-only checkout recovery', {timeout:15000}, async () => {
  const original = readDatabaseConfig().DATABASE_URL, adminPool = createPool(original);
  let admin, schema, pool, server;
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin,'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/017_payment_history.sql',import.meta.url),'utf8'));
    const f = await paymentFixture(admin), reservation = await f.reservation(), token = newToken(), secret = 'ab'.repeat(32);
    const activate = async (user,raw) => {
      await admin.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1",[user]);
      await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[user,digest(raw),digest(csrfFor(raw,secret))]);
    };
    await activate(f.user,token);
    const at = (await admin.query(`SELECT to_char((clock_timestamp()-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
    const all = [];
    for(let n=0;n<24;n++) {
      const shift = n===22 ? -1 : n===23 ? 1 : 0;
      const pay = (await admin.query(`INSERT INTO payment_attempts(reservation_id,show_id,user_id,amount_minor,currency,created_at)
        VALUES($1,$2,$3,75000,'INR',$4::timestamptz+($5::int*interval '1 microsecond'))
        RETURNING *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,[reservation.id,f.show,f.user,at,shift])).rows[0];
      all.push(pay);
      if(n===0) await admin.query("UPDATE payment_attempts SET status='PENDING' WHERE id=$1",[pay.id]);
      if(n===1) await admin.query("UPDATE payment_attempts SET status='FAILED' WHERE id=$1",[pay.id]);
      if(n===2 || n===3) {
        await admin.query('UPDATE payment_attempts SET provider_payment_id=$2 WHERE id=$1',[pay.id,'sim_history_'+pay.id]);
        await f.capture(pay,n===2?await f.booking(reservation):null);
        if(n===3) await f.refund(pay,'DUPLICATE_PAYMENT');
      }
    }
    const foreign = await paymentFixture(admin), otherToken = newToken();
    await activate(foreign.user,otherToken); const otherReservation = await foreign.reservation(), foreignPay = await foreign.attempt(otherReservation);
    await admin.query('COMMIT');
    const url = new URL(original); url.searchParams.set('options',`-c search_path=${schema},public`); pool = createPool(url.toString());
    server = createApp({pool,config:{NODE_ENV:'test',AUTH_SECRET:secret,PUBLIC_ORIGIN:'http://127.0.0.1'},logger:{info(){},error(){}}}).listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const fetchImpl = (path,options={})=>fetch(base+path,{...options,headers:{Cookie:`seatledger_session=${token}`}});
    const expected = all.sort((a,b)=>a.at===b.at?a.id.localeCompare(b.id):a.at>b.at?-1:1);
    const first = await readAccountPayments({fetchImpl}); assert.equal(first.items.length,20);
    assert.deepEqual(first.items.map(p=>p.id),expected.slice(0,20).map(p=>p.id));
    assert.equal(decodeHistoryCursor(first.nextCursor).at,at,'The tied boundary preserves all SQL microseconds');
    const second = await readAccountPayments({cursor:first.nextCursor,fetchImpl}); assert.equal(second.nextCursor,null);
    assert.deepEqual([...first.items,...second.items].map(p=>p.id),expected.map(p=>p.id));
    assert.equal(new Set([...first.items,...second.items].map(p=>p.id)).size,24);
    const byId = new Map([...first.items,...second.items].map(p=>[p.id,p]));
    assert.ok([...byId.values()].some(p=>p.status==='FAILED'));
    assert.ok([...byId.values()].some(p=>p.status==='PENDING'));
    assert.ok([...byId.values()].some(p=>p.resolution==='BOOKED'&&p.bookingId));
    assert.ok([...byId.values()].some(p=>p.resolution==='REFUND_REQUIRED'&&p.bookingId===null));
    assert.ok(!byId.has(foreignPay.id));
    const route = paymentHistoryCheckoutPath(first.items[0]);
    assert.equal(route,`/events/${first.items[0].currentProgramme.eventId}/shows/${f.show}/checkout/${reservation.id}`);
    assert.equal((await fetchImpl('/api/reservations/'+reservation.id)).status,200,'Checkout can recover the saved agreement after confirmation');
    const before = (await pool.query('SELECT (SELECT count(*) FROM payment_attempts) AS payments,(SELECT count(*) FROM refunds) AS refunds,(SELECT count(*) FROM outbox_events) AS jobs')).rows[0];
    for(let i=0;i<3;i++) await readAccountPayments({fetchImpl});
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM payment_attempts) AS payments,(SELECT count(*) FROM refunds) AS refunds,(SELECT count(*) FROM outbox_events) AS jobs')).rows[0],before);
    const response = await fetchImpl('/api/payments'); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(base+'/api/payments')).status,401);
    const other = await readAccountPayments({fetchImpl:(path,options)=>fetch(base+path,{...options,headers:{Cookie:`seatledger_session=${otherToken}`}})});
    assert.deepEqual(other.items.map(p=>p.id),[foreignPay.id]);
    const foreignCursorPage = await readAccountPayments({cursor:first.nextCursor,fetchImpl:(path,options)=>fetch(base+path,{...options,headers:{Cookie:`seatledger_session=${otherToken}`}})});
    assert.deepEqual(foreignCursorPage.items,[],'A foreign cursor still cannot expose another owner');
    for(const query of ['?userId='+foreign.user,'?cursor=bad','?cursor=a&cursor=b']) assert.equal((await fetchImpl('/api/payments'+query)).status,400);
    await pool.query("UPDATE events SET title='Changed current title',status='DRAFT' WHERE id=(SELECT event_id FROM shows WHERE id=$1)",[f.show]);
    const changed = await readAccountPayments({fetchImpl}); assert.equal(changed.items[0].currentProgramme.title,'Changed current title');
    assert.equal(changed.items[0].amountMinor,75000);
    const serialized = JSON.stringify(changed);
    for(const secretField of ['request_key','provider_payment_id','token_hash','lease_token']) assert.ok(!serialized.includes(secretField));
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[digest(token)]);
    assert.equal((await fetchImpl('/api/payments')).status,401);
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(pool)await pool.end();
    if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();
  }
});
