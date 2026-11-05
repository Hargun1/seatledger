import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken,csrfFor,digest } from '../../apps/api/src/auth/security.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { bookingRequest } from '../../apps/web/src/bookings/client.js';

test('owned booking receipt and tied-time history through authenticated HTTP/PostgreSQL',async()=>{
 const adminPool=createPool(readDatabaseConfig().DATABASE_URL);let admin,pool,schema,server;
 try{
  admin=await adminPool.connect();await admin.query('BEGIN');schema=await installReliabilitySchema(admin,'auth_test');
  const f=await paymentFixture(admin);await admin.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1",[f.user]);
  const token=newToken(),secret='ab'.repeat(32);await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[f.user,digest(token),digest(csrfFor(token,secret))]);
  const reservations=[];for(let i=0;i<22;i++)reservations.push(await f.reservation());
  const at=(await admin.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
  const ids=[];for(const r of reservations){
   await admin.query("UPDATE reservations SET status='CONFIRMED',closed_at=clock_timestamp() WHERE id=$1",[r.id]);
   const b=(await admin.query("INSERT INTO bookings(reservation_id,user_id,show_id,currency,total_minor,created_at) VALUES($1,$2,$3,'INR',75000,$4) RETURNING id",[r.id,f.user,f.show,at])).rows[0].id;ids.push(b);
   await admin.query("INSERT INTO booking_items(booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number) VALUES($1,$2,$3,$4,75000,'INR','Saved stalls','A',1)",[b,r.id,f.show,f.seat]);
   await admin.query('UPDATE bookings SET sealed_at=clock_timestamp() WHERE id=$1',[b]);
  }
  await admin.query('COMMIT');const url=new URL(readDatabaseConfig().DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);pool=createPool(url.toString());
  server=createApp({pool,config:{NODE_ENV:'test',AUTH_SECRET:secret,PUBLIC_ORIGIN:'http://127.0.0.1'},logger:{info(){},error(){}}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`,fetchImpl=(path,options)=>fetch(base+path,{...options,headers:{Cookie:`seatledger_session=${token}`}});
  const first=await bookingRequest({fetchImpl});assert.equal(first.items.length,20);assert.deepEqual(first.items.map(x=>x.id),ids.sort().slice(0,20));
  const cursor=JSON.parse(Buffer.from(first.nextCursor,'base64url'));assert.equal(cursor.at,at,'Preserve SQL microseconds');
  const second=await bookingRequest({cursor:first.nextCursor,fetchImpl});assert.deepEqual(second.items.map(x=>x.id),ids.slice(20));assert.equal(second.nextCursor,null);
  const detail=await bookingRequest({id:ids[0],fetchImpl});assert.equal(detail.items[0].section,'Saved stalls');assert.equal(detail.totalMinor,75000);
  const response=await fetchImpl('/api/bookings/'+ids[0],{});assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/api/bookings/'+ids[0])).status,401);
  assert.equal((await fetchImpl('/api/bookings/'+randomUUID(),{})).status,404);assert.equal((await fetchImpl('/api/bookings/not-a-uuid',{})).status,404);
  for(const path of ['/api/bookings?userId='+f.user,'/api/bookings?cursor=bad','/api/bookings/'+ids[0]+'?extra=1'])assert.equal((await fetchImpl(path,{})).status,400);
  const other=(await pool.query("INSERT INTO users(email,display_name,status) VALUES($1,'Other','DISABLED') RETURNING id",[randomUUID()+'@test.invalid'])).rows[0].id;
  const otherToken=newToken();await pool.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1",[other]);
  await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[other,digest(otherToken),digest(csrfFor(otherToken,secret))]);
  assert.equal((await fetch(base+'/api/bookings/'+ids[0],{headers:{Cookie:`seatledger_session=${otherToken}`}})).status,404);
  assert.deepEqual((await (await fetch(base+'/api/bookings',{headers:{Cookie:`seatledger_session=${otherToken}`}})).json()).items,[]);
  await pool.query("UPDATE bookings SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=$1",[ids[0]]);
  await pool.query("UPDATE events SET title='Current title',status='DRAFT' WHERE id=(SELECT event_id FROM shows WHERE id=$1)",[f.show]);
  await pool.query("UPDATE venue_sections SET name='Changed section' WHERE id=(SELECT section_id FROM venue_seats WHERE id=$1)",[f.seat]);
  const cancelled=await bookingRequest({id:ids[0],fetchImpl});assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.items[0].section,'Saved stalls');assert.equal(cancelled.currentProgramme.title,'Current title');
  const total=(await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n;await bookingRequest({fetchImpl});assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,total);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(pool)await pool.end();if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();}
});
