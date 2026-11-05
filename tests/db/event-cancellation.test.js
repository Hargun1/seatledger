import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from '../../apps/api/src/db.js';
import {readDatabaseConfig} from '../../apps/api/src/config.js';
import {createApp} from '../../apps/api/src/app.js';
import {newToken,csrfFor,digest} from '../../apps/api/src/auth/security.js';
import {createReservation} from '../../apps/api/src/reservations/service.js';
import {readTickets} from '../../apps/api/src/bookings/tickets.js';
import {runEventCancellationBatch,cancelEventBooking,EventCancellationStale} from '../../apps/api/src/organizers/event-cancellation-jobs.js';
import {installReliabilitySchema} from '../helpers/reliability-schema.js';
import {paymentFixture} from '../helpers/payment-fixture.js';
import {eventCancellationRequest} from '../../apps/web/src/organizers/event-cancellation.js';
import {bookingRequest} from '../../apps/web/src/bookings/client.js';

test('durable event cancellation: owner boundary, immediate closure, bounded/restarted/two-worker cleanup, rollback, review/resume and generation fencing',{timeout:30000},async()=>{
  const original=readDatabaseConfig().DATABASE_URL,adminPool=createPool(original),servers=[];let admin,schema,pool,otherPool;
  const secret='ab'.repeat(32),origin='https://events.test';
  try{
    admin=await adminPool.connect();await admin.query('BEGIN');schema=await installReliabilitySchema(admin,'auth_test');
    for(const file of ['015_admission_tickets.sql','019_event_cancellation_jobs.sql'])await admin.query(await readFile(new URL('../../db/migrations/'+file,import.meta.url),'utf8'));
    async function actor(){const user=randomUUID(),token=newToken(),csrf=csrfFor(token,secret);await admin.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,'Actor','fixture-not-for-login')",[user,user+'@test.invalid']);
      await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[user,digest(token),digest(csrf)]);return {user,token,csrf};}
    const owner=await actor(),staff=await actor(),outsider=await actor();
    async function fixture(withHold=false){
      const f=await paymentFixture(admin),r=await f.reservation(),b=await f.booking(r),p=await f.attempt(r);await f.capture(p,b);
      const show=(await admin.query('SELECT * FROM shows WHERE id=$1',[f.show])).rows[0];
      await admin.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1",[show.organizer_id,owner.user]);
      await admin.query("UPDATE events SET status='PUBLISHED' WHERE id=$1",[show.event_id]);
      for(const [who,role] of [[owner,'OWNER'],[staff,'STAFF']])await admin.query('INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,$3)',[show.organizer_id,who.user,role]);
      await admin.query("UPDATE show_seats SET state='BOOKED',reservation_id=$2,booking_id=$3,expires_at=NULL WHERE show_id=$1 AND venue_seat_id=$4",[f.show,r.id,b,f.seat]);
      await admin.query('INSERT INTO admission_tickets(booking_item_id,booking_id,show_id,issued_by) SELECT id,booking_id,show_id,$2 FROM booking_items WHERE booking_id=$1',[b,f.user]);
      const customerToken=newToken();await admin.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1",[f.user]);
      await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[f.user,digest(customerToken),digest(csrfFor(customerToken,secret))]);
      let hold=null;if(withHold){const seat=(await admin.query('SELECT * FROM venue_seats WHERE id=$1',[f.seat])).rows[0],second=randomUUID();
        await admin.query("INSERT INTO venue_seats(id,venue_id,section_id,row_label,seat_number) VALUES($1,$2,$3,'B',2)",[second,seat.venue_id,seat.section_id]);
        await admin.query('INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) VALUES($1,$2,$3,75000)',[f.show,second,seat.venue_id]);
        hold=await createReservation(admin,f.user,{showId:f.show,seatIds:[second]});}
      return {...f,r,b,p,hold,customerToken,organizationId:show.organizer_id,eventId:show.event_id};
    }
    const x=await fixture(true),poison=await fixture(),admitted=await fixture(),past=await fixture(),requestRollback=await fixture(),revoked=await fixture();
    await admin.query('INSERT INTO ticket_checkins(booking_item_id,show_id,organizer_id,checked_by,request_key) SELECT id,show_id,$2,$3,$4 FROM booking_items WHERE booking_id=$1',[admitted.b,admitted.organizationId,staff.user,randomUUID()]);
    await admin.query('COMMIT');const url=new URL(original);url.searchParams.set('options',`-c search_path=${schema},public`);pool=createPool(url.toString());otherPool=createPool(url.toString());
    const bases=[];for(const target of [pool,otherPool]){const s=createApp({pool:target,config:{NODE_ENV:'test',AUTH_SECRET:secret,PUBLIC_ORIGIN:origin},logger:{info(){},error(){}}}).listen(0,'127.0.0.1');servers.push(s);await new Promise(r=>s.once('listening',r));bases.push(`http://127.0.0.1:${s.address().port}`);}
    const api=(f=x,who=owner,index=0)=>({organizationId:f.organizationId,eventId:f.eventId,csrfToken:who.csrf,fetchImpl:(path,o={})=>fetch(bases[index]+path,{...o,headers:{...o.headers,Cookie:`seatledger_session=${who.token}`,...(o.method==='POST'?{Origin:origin}:{})}})});
    const tx=async(work,target=pool)=>{const db=await target.connect();try{await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
    const job=f=>pool.query('SELECT * FROM event_cancellation_jobs WHERE event_id=$1',[f.eventId]).then(r=>r.rows[0]);
    const due=f=>pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM(next_attempt_at-clock_timestamp())))+0.01) FROM event_cancellation_jobs WHERE event_id=$1",[f.eventId]);
    assert.equal((await eventCancellationRequest('read',api())).requestable,true);
    assert.equal((await fetch(bases[0]+`/api/organizers/${x.organizationId}/events/${x.eventId}/cancellation`)).status,401);
    await assert.rejects(eventCancellationRequest('request',api(x,staff)),e=>e.status===403);
    await assert.rejects(eventCancellationRequest('read',api(x,outsider)),e=>e.status===404);
    await assert.rejects(eventCancellationRequest('read',{...api(),eventId:poison.eventId}),e=>e.status===404,'Event identity must belong to the scoped organization');
    await assert.rejects(eventCancellationRequest('request',{...api(),csrfToken:'b'.repeat(43)}),e=>e.status===403);
    assert.equal((await eventCancellationRequest('read',api(admitted))).requestable,false);
    await assert.rejects(eventCancellationRequest('request',api(admitted)),e=>e.status===409);
    await pool.query("UPDATE shows SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1",[past.show]);
    await assert.rejects(eventCancellationRequest('request',api(past)),e=>e.status===409);
    await pool.query(`CREATE FUNCTION reject_event_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='event.cancellation_requested' AND NEW.entity_id='${requestRollback.eventId}'::uuid THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_event_request BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_event_request()');
    await assert.rejects(eventCancellationRequest('request',api(requestRollback)),e=>e.status===500);
    assert.equal(await job(requestRollback),undefined);assert.equal((await pool.query('SELECT status FROM events WHERE id=$1',[requestRollback.eventId])).rows[0].status,'PUBLISHED');
    await pool.query('DROP TRIGGER reject_event_request ON audit_events');await pool.query('DROP FUNCTION reject_event_request()');
    const privateCredential=(await readTickets(pool,x.user,x.b,secret)).tickets[0].credential;
    const replies=await Promise.all(Array.from({length:6},(_,n)=>eventCancellationRequest('request',api(x,owner,n%2))));
    assert.ok(replies.every(v=>v.event.status==='CANCELLED'&&v.job.status==='PENDING'));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.cancellation_requested'",[x.eventId])).rows[0].n,1);
    assert.equal((await readTickets(pool,x.user,x.b,secret)).tickets[0].status,'VOID','Parent closure revokes admission before allocation cleanup');
    const scan=await api(x,staff).fetchImpl(`/api/organizers/${x.organizationId}/shows/${x.show}/check-ins`,{method:'POST',headers:{'Content-Type':'application/json','X-SeatLedger-Client':'web','X-CSRF-Token':staff.csrf},body:JSON.stringify({credential:privateCredential,requestKey:randomUUID()})});
    assert.equal(scan.status,409,'A credential issued before closure cannot admit afterward');
    const receipt=await bookingRequest({id:x.b,fetchImpl:(path,o)=>fetch(bases[0]+path,{...o,headers:{Cookie:`seatledger_session=${x.customerToken}`}})});
    assert.equal(receipt.status,'CONFIRMED');assert.equal(receipt.currentProgramme.eventStatus,'CANCELLED');
    await assert.rejects(tx(db=>createReservation(db,x.user,{showId:x.show,seatIds:[x.seat]})),e=>e.status===404);
    const first=await runEventCancellationBatch(pool,{batchSize:1});assert.equal(first.cancelledBookings,1);assert.equal(first.releasedHolds,0);
    const partial=await eventCancellationRequest('read',api());assert.equal(partial.counts.activeHolds,1);assert.equal(partial.counts.refundRequests,1);assert.equal(partial.counts.refundsCompleted,0);
    await due(x);const parallel=await Promise.all([runEventCancellationBatch(pool,{batchSize:1}),runEventCancellationBatch(otherPool,{batchSize:1})]);
    assert.equal(parallel.reduce((n,c)=>n+c.releasedHolds,0),1);assert.equal((await job(x)).status,'COMPLETED');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.hold_released'",[x.hold.id])).rows[0].n,1);
    const complete=await eventCancellationRequest('request',api());assert.equal(complete.job.status,'COMPLETED');assert.equal(complete.counts.refundsCompleted,0);
    const progressResponse=await api().fetchImpl(`/api/organizers/${x.organizationId}/events/${x.eventId}/cancellation`);
    assert.equal(progressResponse.headers.get('cache-control'),'no-store');
    assert.equal((await api().fetchImpl(`/api/organizers/${x.organizationId}/events/${x.eventId}/cancellation?owner=other`)).status,400);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE payment_attempt_id=$1',[x.p.id])).rows[0].n,1);
    await eventCancellationRequest('request',api(poison));const oldJob=await job(poison);
    await pool.query(`CREATE FUNCTION reject_event_booking_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='booking.cancelled' AND NEW.entity_id='${poison.b}'::uuid THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_event_booking_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_event_booking_audit()');
    for(let n=1;n<=8;n++){const failed=await runEventCancellationBatch(pool,{retryDelaySeconds:0});assert.equal(failed.failed,1);assert.equal((await job(poison)).failed_attempts,n);}
    assert.equal((await job(poison)).status,'NEEDS_REVIEW');assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1',[poison.b])).rows[0].status,'CONFIRMED');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE payment_attempt_id=$1',[poison.p.id])).rows[0].n,0);
    await pool.query('DROP TRIGGER reject_event_booking_audit ON audit_events');await pool.query('DROP FUNCTION reject_event_booking_audit()');
    const resumed=await Promise.all([eventCancellationRequest('resume',{...api(poison),expectedGeneration:0}),eventCancellationRequest('resume',{...api(poison,owner,1),expectedGeneration:0})]);
    assert.ok(resumed.every(v=>v.job.generation===1));
    await assert.rejects(cancelEventBooking(otherPool,oldJob,poison.b),e=>e instanceof EventCancellationStale);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE payment_attempt_id=$1',[poison.p.id])).rows[0].n,0);
    assert.equal((await runEventCancellationBatch(pool)).cancelledBookings,1);assert.equal((await job(poison)).status,'COMPLETED');
    await assert.rejects(pool.query('UPDATE event_cancellation_jobs SET failed_attempts=1 WHERE event_id=$1',[poison.eventId]),e=>e.code==='23514');
    await eventCancellationRequest('request',api(revoked));
    await pool.query('UPDATE organizer_memberships SET revoked_at=clock_timestamp() WHERE organizer_id=$1 AND user_id=$2',[revoked.organizationId,owner.user]);
    await assert.rejects(eventCancellationRequest('read',api(revoked)),e=>e.status===404);
    assert.equal((await runEventCancellationBatch(otherPool)).cancelledBookings,1,'Accepted customer cleanup survives later owner revocation');
    assert.equal((await eventCancellationRequest('read',api(revoked,staff))).job.status,'COMPLETED');
  }finally{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}if(pool)await pool.end();if(otherPool)await otherPool.end();if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();}
});
