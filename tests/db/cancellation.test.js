import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from '../../apps/api/src/db.js';
import {readDatabaseConfig} from '../../apps/api/src/config.js';
import {createApp} from '../../apps/api/src/app.js';
import {newToken,csrfFor,digest} from '../../apps/api/src/auth/security.js';
import {cancelBooking,cancellationPolicy,readCancellation} from '../../apps/api/src/bookings/cancellation.js';
import {checkInTicket} from '../../apps/api/src/bookings/checkins.js';
import {ticketCredential,readTickets} from '../../apps/api/src/bookings/tickets.js';
import {createReservation} from '../../apps/api/src/reservations/service.js';
import {installReliabilitySchema} from '../helpers/reliability-schema.js';
import {paymentFixture} from '../helpers/payment-fixture.js';
import {cancellationRequest,readBookingPolicy} from '../../apps/web/src/bookings/cancellation.js';

test('customer cancellation: owned two-API natural replay, whole release/refund, cutoff/admission refusal, audit/deadline rollback and newer-holder safety',{timeout:30000},async()=>{
  const original=readDatabaseConfig().DATABASE_URL,adminPool=createPool(original),servers=[];let admin,schema,pool,otherPool;
  const secret='ab'.repeat(32),origin='https://cancel.test',policy=cancellationPolicy({});
  try{
    admin=await adminPool.connect();await admin.query('BEGIN');schema=await installReliabilitySchema(admin,'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/015_admission_tickets.sql',import.meta.url),'utf8'));
    async function fixture(multi=false){
      const f=await paymentFixture(admin);let r,b;
      if(multi){
        const seat=(await admin.query('SELECT venue_id,section_id FROM venue_seats WHERE id=$1',[f.seat])).rows[0],second=randomUUID();
        await admin.query("INSERT INTO venue_seats(id,venue_id,section_id,row_label,seat_number) VALUES($1,$2,$3,'A',2)",[second,seat.venue_id,seat.section_id]);
        await admin.query("INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) VALUES($1,$2,$3,75000)",[f.show,second,seat.venue_id]);
        r=(await admin.query("INSERT INTO reservations(user_id,show_id,total_minor,currency) VALUES($1,$2,150000,'INR') RETURNING *",[f.user,f.show])).rows[0];
        await admin.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) SELECT $1,$2,unnest($3::uuid[]),75000,'INR'",[r.id,f.show,[f.seat,second]]);
        await admin.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1',[r.id]);
        await admin.query("UPDATE reservations SET status='CONFIRMED',closed_at=clock_timestamp() WHERE id=$1",[r.id]);
        b=(await admin.query("INSERT INTO bookings(reservation_id,user_id,show_id,total_minor,currency) VALUES($1,$2,$3,150000,'INR') RETURNING id",[r.id,f.user,f.show])).rows[0].id;
        await admin.query(`INSERT INTO booking_items(booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number)
          SELECT $1,$2,$3,s.id,75000,'INR','Stalls',s.row_label,s.seat_number FROM venue_seats s WHERE s.id=ANY($4::uuid[])`,[b,r.id,f.show,[f.seat,second]]);
        await admin.query('UPDATE bookings SET sealed_at=clock_timestamp() WHERE id=$1',[b]);
      }else{r=await f.reservation();b=await f.booking(r);}
      const p=await f.attempt(r);await f.capture(p,b);
      await admin.query("UPDATE show_seats SET state='BOOKED',reservation_id=$1,booking_id=$2,expires_at=NULL WHERE show_id=$3",[r.id,b,f.show]);
      await admin.query("UPDATE users SET status='ACTIVE',password_hash='fixture-not-for-login' WHERE id=$1",[f.user]);
      const show=(await admin.query('SELECT organizer_id,event_id FROM shows WHERE id=$1',[f.show])).rows[0];
      await admin.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1",[show.organizer_id,f.user]);
      await admin.query("UPDATE events SET status='PUBLISHED' WHERE id=$1",[show.event_id]);
      await admin.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER')",[show.organizer_id,f.user]);
      const ticket=(await admin.query('INSERT INTO admission_tickets(booking_item_id,booking_id,show_id,issued_by) SELECT id,booking_id,show_id,$2 FROM booking_items WHERE booking_id=$1 RETURNING id',[b,f.user])).rows[0].id;
      const token=newToken(),csrf=csrfFor(token,secret);await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[f.user,digest(token),digest(csrf)]);
      return {...f,r,b,p,token,csrf,org:show.organizer_id,credential:ticketCredential(ticket,secret)};
    }
    const x=await fixture(true),soon=await fixture(),used=await fixture(),rollback=await fixture(),crossing=await fixture(),race=await fixture();
    await admin.query('COMMIT');const url=new URL(original);url.searchParams.set('options',`-c search_path=${schema},public`);pool=createPool(url.toString());otherPool=createPool(url.toString());
    const bases=[];for(const target of [pool,otherPool]){const s=createApp({pool:target,config:{NODE_ENV:'test',AUTH_SECRET:secret,PUBLIC_ORIGIN:origin},logger:{info(){},error(){}}}).listen(0,'127.0.0.1');servers.push(s);await new Promise(r=>s.once('listening',r));bases.push(`http://127.0.0.1:${s.address().port}`);}
    const api=(f=x,index=0)=>({bookingId:f.b,csrfToken:f.csrf,fetchImpl:(path,o={})=>fetch(bases[index]+path,{...o,headers:{...o.headers,Cookie:`seatledger_session=${f.token}`,...(o.method==='POST'?{Origin:origin}:{})}})});
    const tx=async(work,target=pool)=>{const db=await target.connect();try{await db.query('BEGIN');const v=await work(db);await db.query('COMMIT');return v;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
    assert.equal((await readBookingPolicy({fetchImpl:api().fetchImpl})).cutoffMinutes,60);
    await pool.query("UPDATE shows SET starts_at='2030-01-01T18:00:00.123456Z'::timestamptz WHERE id=$1",[x.show]);
    const preview=await cancellationRequest(api());assert.equal(preview.eligible,true);
    assert.equal(preview.deadline,'2030-01-01T17:00:00.123456Z','Subtract cutoff before formatting the exact UTC instant');
    await tx(async db=>{
      await db.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
      const otherPolicy=cancellationPolicy({CUSTOMER_CANCELLATION_CUTOFF_MINUTES:90});
      assert.equal((await readCancellation(db,x.user,x.b,otherPolicy)).deadline,'2030-01-01T16:30:00.123456Z',
        'Cutoff arithmetic and UTC microseconds are independent of session timezone');
    });
    assert.equal((await fetch(bases[0]+`/api/bookings/${x.b}/cancellation`)).status,401);
    await assert.rejects(cancellationRequest({...api(soon),bookingId:x.b}),e=>e.status===404);
    await assert.rejects(cancellationRequest({...api(),cancel:true,csrfToken:'c'.repeat(43)}),e=>e.status===403);
    const replies=await Promise.all(Array.from({length:6},(_,n)=>cancellationRequest({...api(x,n%2),cancel:true})));
    assert.ok(replies.every(v=>v.status==='CANCELLED'&&v.refundId===replies[0].refundId));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE payment_attempt_id=$1',[x.p.id])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='booking.cancelled'",[x.b])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM show_seats WHERE show_id=$1 AND state='AVAILABLE'",[x.show])).rows[0].n,2);
    assert.equal((await pool.query('SELECT amount_minor::text AS amount FROM refunds WHERE payment_attempt_id=$1',[x.p.id])).rows[0].amount,'150000');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM booking_items WHERE booking_id=$1',[x.b])).rows[0].n,2);
    assert.equal((await readTickets(pool,x.user,x.b,secret)).tickets[0].status,'VOID');
    assert.equal((await pool.query('SELECT status FROM reservations WHERE id=$1',[x.r.id])).rows[0].status,'CONFIRMED','Reservation history stays confirmed');
    const replacement=await tx(db=>createReservation(db,x.user,{showId:x.show,seatIds:[x.seat]}));
    // This fixture has TWO seats; a show-only query has no defined first row.
    // Verify the exact held chair, then protect the whole inventory snapshot.
    const stockSnapshot=async()=>(await pool.query(`SELECT venue_seat_id AS id,state,reservation_id AS "reservationId",booking_id AS "bookingId",
      to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry
      FROM show_seats WHERE show_id=$1 ORDER BY venue_seat_id`,[x.show])).rows;
    const beforeReplay=await stockSnapshot(),held=beforeReplay.find(s=>s.id===x.seat);
    assert.equal(beforeReplay.length,2);assert.equal(held.state,'HELD');assert.equal(held.reservationId,replacement.id);
    assert.equal(held.expiry,replacement.expiresAt);assert.equal(held.bookingId,null);
    assert.ok(beforeReplay.filter(s=>s.id!==x.seat).every(s=>s.state==='AVAILABLE'&&s.reservationId===null&&s.bookingId===null&&s.expiry===null));
    await cancellationRequest({...api(),cancel:true});
    const afterReplay=await stockSnapshot();
    assert.equal(afterReplay.find(s=>s.id===x.seat).reservationId,replacement.id);
    assert.deepEqual(afterReplay,beforeReplay,'Replay must preserve both the replacement hold and the other available chair');
    await pool.query("UPDATE shows SET starts_at=clock_timestamp()+interval '30 minutes' WHERE id=$1",[soon.show]);
    assert.equal((await cancellationRequest(api(soon))).reason,'CUTOFF_PASSED');
    await assert.rejects(cancellationRequest({...api(soon),cancel:true}),e=>e.status===409);
    const scan=f=>tx(db=>checkInTicket(db,{user:{id:f.user,role:'CUSTOMER'}},f.org,f.show,{credential:f.credential,requestKey:randomUUID()},secret),otherPool);
    await scan(used);assert.equal((await cancellationRequest(api(used))).reason,'ALREADY_USED');
    await assert.rejects(cancellationRequest({...api(used),cancel:true}),e=>e.status===409);
    const raced=await Promise.allSettled([tx(db=>cancelBooking(db,race.user,race.b,policy)),scan(race)]);
    assert.equal(raced.filter(v=>v.status==='fulfilled').length,1,'Exactly one cancellation/admission can succeed');
    const raceStatus=(await pool.query('SELECT status FROM bookings WHERE id=$1',[race.b])).rows[0].status;
    const checked=(await pool.query('SELECT count(*)::int AS n FROM ticket_checkins WHERE show_id=$1',[race.show])).rows[0].n;
    assert.equal(checked,raceStatus==='CANCELLED'?0:1);
    await pool.query(`CREATE FUNCTION reject_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='${rollback.b}'::uuid THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_cancel_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_cancel_audit()');
    await assert.rejects(cancellationRequest({...api(rollback),cancel:true}),e=>e.status===500);
    assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1',[rollback.b])).rows[0].status,'CONFIRMED');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE payment_attempt_id=$1',[rollback.p.id])).rows[0].n,0);
    assert.equal((await pool.query('SELECT state FROM show_seats WHERE show_id=$1',[rollback.show])).rows[0].state,'BOOKED');
    await pool.query('DROP TRIGGER reject_cancel_audit ON audit_events');await pool.query('DROP FUNCTION reject_cancel_audit()');
    await pool.query('CREATE SEQUENCE cancel_deadline_probe');
    await pool.query(`CREATE FUNCTION delay_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='${crossing.b}'::uuid THEN PERFORM nextval('cancel_deadline_probe');
      PERFORM pg_sleep(GREATEST(0,(SELECT EXTRACT(epoch FROM (starts_at-interval '60 minutes'-clock_timestamp())) FROM shows WHERE id='${crossing.show}'::uuid))+0.02); END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER delay_cancel_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION delay_cancel_audit()');
    await pool.query("UPDATE shows SET starts_at=clock_timestamp()+interval '60 minutes 1 second' WHERE id=$1",[crossing.show]);
    await assert.rejects(cancellationRequest({...api(crossing),cancel:true}),e=>e.status===409);
    assert.equal((await pool.query('SELECT is_called FROM cancel_deadline_probe')).rows[0].is_called,true);
    assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1',[crossing.b])).rows[0].status,'CONFIRMED');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE payment_attempt_id=$1',[crossing.p.id])).rows[0].n,0);
    assert.equal((await pool.query('SELECT state FROM show_seats WHERE show_id=$1',[crossing.show])).rows[0].state,'BOOKED');
    const response=await api().fetchImpl(`/api/bookings/${x.b}/cancellation`);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await api().fetchImpl(`/api/bookings/${x.b}/cancellation?owner=other`)).status,400);
  }finally{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}if(pool)await pool.end();if(otherPool)await otherPool.end();if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();}
});
