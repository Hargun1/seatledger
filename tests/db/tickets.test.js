import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from '../../apps/api/src/db.js';
import {readDatabaseConfig} from '../../apps/api/src/config.js';
import {createApp} from '../../apps/api/src/app.js';
import {newToken,csrfFor,digest} from '../../apps/api/src/auth/security.js';
import {installReliabilitySchema} from '../helpers/reliability-schema.js';
import {paymentFixture} from '../helpers/payment-fixture.js';
import {verifyTicketCredential,issueTickets} from '../../apps/api/src/bookings/tickets.js';
import {ticketRequest} from '../../apps/web/src/bookings/tickets.js';
import {readPrintableTickets} from '../../apps/web/src/bookings/printable.js';

test('ticket issuance and recovery are atomic, owned, replay-safe and cancellation-aware (PostgreSQL/HTTP)',{timeout:30000},async()=>{
 const original=readDatabaseConfig().DATABASE_URL,adminPool=createPool(original);let admin,schema,pool,server;
 const secret='ab'.repeat(32),origin='https://tickets.test';
 try{
  admin=await adminPool.connect();await admin.query('BEGIN');schema=await installReliabilitySchema(admin,'auth_test');await admin.query(await readFile(new URL('../../db/migrations/015_admission_tickets.sql',import.meta.url),'utf8'));
  async function fixture(paid=true){const f=await paymentFixture(admin);await admin.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1",[f.user]);const r=await f.reservation(),b=await f.booking(r);
   if(paid){const p=await f.attempt(r);await f.capture(p,b);}await admin.query("UPDATE show_seats SET state='BOOKED',reservation_id=$1,booking_id=$2,expires_at=NULL WHERE show_id=$3",[r.id,b,f.show]);
   const token=newToken(),csrf=csrfFor(token,secret);await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[f.user,digest(token),digest(csrf)]);return {...f,r,b,token,csrf};}
  const x=await fixture(),unpaid=await fixture(false),rollback=await fixture(),crossing=await fixture();await admin.query('COMMIT');
  const url=new URL(original);url.searchParams.set('options',`-c search_path=${schema},public`);pool=createPool(url.toString());
  server=createApp({pool,config:{NODE_ENV:'test',AUTH_SECRET:secret,PUBLIC_ORIGIN:origin},logger:{info(){},error(){}}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  const context=(f=x)=>({bookingId:f.b,showId:f.show,seatIds:[f.seat],csrfToken:f.csrf,fetchImpl:(path,o)=>fetch(base+path,{...o,headers:{...o.headers,Cookie:`seatledger_session=${f.token}`,...(o.method==='POST'?{Origin:origin}:{})}})});
  assert.equal((await ticketRequest(context())).tickets.length,0);
  await Promise.all(Array.from({length:6},()=>ticketRequest({...context(),issue:true})));
  const first=await ticketRequest(context());assert.equal(first.tickets.length,1);assert.equal(verifyTicketCredential(first.tickets[0].credential,secret),first.tickets[0].id);
  const printFor=(f=x)=>readPrintableTickets({bookingId:f.b,fetchImpl:context(f).fetchImpl});
  const printable=await printFor();assert.equal(printable.tickets.length,1);assert.equal(printable.tickets[0].credential,first.tickets[0].credential);
  await assert.rejects(readPrintableTickets({bookingId:x.b,fetchImpl:context(unpaid).fetchImpl}),e=>e.status===404);
  await ticketRequest({...context(),issue:true});assert.deepEqual(await ticketRequest(context()),first);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM admission_tickets WHERE booking_id=$1',[x.b])).rows[0].n,1);
  const response=await context().fetchImpl('/api/bookings/'+x.b+'/tickets',{});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await fetch(base+'/api/bookings/'+x.b+'/tickets')).status,401);
  const foreign=await context(unpaid).fetchImpl('/api/bookings/'+x.b+'/tickets',{});assert.equal(foreign.status,404);
  await assert.rejects(ticketRequest({...context(unpaid),issue:true}),e=>e.status===409);
  await assert.rejects(ticketRequest({...context(),issue:true,csrfToken:'b'.repeat(43)}),e=>e.status===403);
  await pool.query(`CREATE FUNCTION fail_ticket_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.booking_id='${rollback.b}'::uuid THEN RAISE EXCEPTION 'fixture ticket failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_ticket_insert BEFORE INSERT ON admission_tickets FOR EACH ROW EXECUTE FUNCTION fail_ticket_insert()');
  await assert.rejects(ticketRequest({...context(rollback),issue:true}),e=>e.status===500);assert.equal((await pool.query('SELECT count(*)::int AS n FROM admission_tickets WHERE booking_id=$1',[rollback.b])).rows[0].n,0);
  await pool.query('DROP TRIGGER fail_ticket_insert ON admission_tickets');await pool.query('DROP FUNCTION fail_ticket_insert()');await ticketRequest({...context(rollback),issue:true});
  await pool.query('CREATE SEQUENCE ticket_deadline_probe');
  await pool.query(`CREATE FUNCTION delay_ticket_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.booking_id='${crossing.b}'::uuid THEN
    PERFORM nextval('ticket_deadline_probe');
    PERFORM pg_sleep(GREATEST(0,(SELECT EXTRACT(epoch FROM (starts_at-clock_timestamp())) FROM shows WHERE id=NEW.show_id))+0.03); END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER delay_ticket_insert BEFORE INSERT ON admission_tickets FOR EACH ROW EXECUTE FUNCTION delay_ticket_insert()');
  await pool.query("UPDATE shows SET starts_at=clock_timestamp()+interval '900 milliseconds' WHERE id=$1",[crossing.show]);
  await assert.rejects(ticketRequest({...context(crossing),issue:true}),e=>e.status===409);assert.equal((await pool.query('SELECT count(*)::int AS n FROM admission_tickets WHERE booking_id=$1',[crossing.b])).rows[0].n,0);
  assert.equal((await pool.query('SELECT is_called FROM ticket_deadline_probe')).rows[0].is_called,true,'Insert must have started before the final deadline refusal');
  await pool.query('DROP TRIGGER delay_ticket_insert ON admission_tickets');await pool.query('DROP FUNCTION delay_ticket_insert()');
  await assert.rejects(pool.query('DELETE FROM admission_tickets WHERE booking_id=$1',[x.b]),e=>e.code==='23514');
  await pool.query(`INSERT INTO ticket_checkins(booking_item_id,show_id,organizer_id,checked_by,request_key)
   SELECT i.id,i.show_id,s.organizer_id,$2,$3 FROM booking_items i JOIN shows s ON s.id=i.show_id WHERE i.booking_id=$1`,[x.b,x.user,randomUUID()]);
  const used=await ticketRequest(context());assert.equal(used.tickets[0].status,'USED');assert.equal(used.tickets[0].credential,null);await assert.rejects(ticketRequest({...context(),issue:true}),e=>e.status===409);
  assert.equal((await printFor()).tickets.length,0);
  await pool.query("UPDATE bookings SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=$1",[x.b]);
  const cancelled=await ticketRequest(context());assert.equal(cancelled.tickets[0].status,'VOID');assert.equal(cancelled.tickets[0].credential,null);await assert.rejects(ticketRequest({...context(),issue:true}),e=>e.status===409);
  assert.equal((await printFor()).tickets.length,0);
  await pool.query("UPDATE shows SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1",[rollback.show]);const expired=await ticketRequest(context(rollback));assert.equal(expired.tickets[0].status,'EXPIRED');assert.equal(expired.tickets[0].credential,null);
  assert.equal((await printFor(rollback)).tickets.length,0);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(pool)await pool.end();if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();}
});
