import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from '../../apps/api/src/db.js';
import {readDatabaseConfig} from '../../apps/api/src/config.js';
import {createApp} from '../../apps/api/src/app.js';
import {newToken,csrfFor,digest} from '../../apps/api/src/auth/security.js';
import {claimOutbox,acknowledgeOutbox,failOutbox} from '../../apps/api/src/reliability/outbox.js';
import {installReliabilitySchema} from '../helpers/reliability-schema.js';
import {paymentFixture} from '../helpers/payment-fixture.js';
import {operationsRequest} from '../../apps/web/src/organizers/operations.js';

test('organizer operations: exact no-fanout totals, scoped role redaction, tied paging, formula-safe page CSV and access revocation',{timeout:20000},async()=>{
  const original=readDatabaseConfig().DATABASE_URL,adminPool=createPool(original);let admin,schema,pool,server;
  const secret='ab'.repeat(32),name='  =SUM(1,2)\r\n"quoted"';
  try{
    admin=await adminPool.connect();await admin.query('BEGIN');schema=await installReliabilitySchema(admin,'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/018_show_booking_history.sql',import.meta.url),'utf8'));
    async function actor(label){const user=randomUUID(),token=newToken();await admin.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,'fixture-not-for-login')",[user,user+'@test.invalid',label]);
      await admin.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[user,digest(token),digest(csrfFor(token,secret))]);return {user,token};}
    const owner=await actor('Owner'),staff=await actor('Staff'),outsider=await actor('Other');
    const f=await paymentFixture(admin),show=(await admin.query('SELECT * FROM shows WHERE id=$1',[f.show])).rows[0];
    await admin.query('UPDATE users SET display_name=$2 WHERE id=$1',[f.user,name]);
    await admin.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1",[show.organizer_id,owner.user]);
    for(const [who,role] of [[owner,'OWNER'],[staff,'STAFF']])await admin.query('INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,$3)',[show.organizer_id,who.user,role]);
    const seat=(await admin.query('SELECT * FROM venue_seats WHERE id=$1',[f.seat])).rows[0],second=randomUUID();
    await admin.query("INSERT INTO venue_seats(id,venue_id,section_id,row_label,seat_number) VALUES($1,$2,$3,'B',2)",[second,seat.venue_id,seat.section_id]);
    await admin.query('INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) VALUES($1,$2,$3,75000)',[f.show,second,seat.venue_id]);
    const at=(await admin.query(`SELECT to_char((clock_timestamp()-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
    const ids=[],refunds=[];
    for(let n=0;n<22;n++){
      const seats=n===0?[f.seat,second]:[f.seat],total=75000*seats.length;
      const r=(await admin.query("INSERT INTO reservations(user_id,show_id,total_minor,currency) VALUES($1,$2,$3,'INR') RETURNING id",[f.user,f.show,total])).rows[0].id;
      await admin.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) SELECT $1,$2,unnest($3::uuid[]),75000,'INR'",[r,f.show,seats]);
      await admin.query("UPDATE reservations SET sealed_at=clock_timestamp(),status='CONFIRMED',closed_at=clock_timestamp() WHERE id=$1",[r]);
      const b=(await admin.query("INSERT INTO bookings(reservation_id,user_id,show_id,total_minor,currency,created_at) VALUES($1,$2,$3,$4,'INR',$5) RETURNING id",[r,f.user,f.show,total,at])).rows[0].id;ids.push(b);
      await admin.query(`INSERT INTO booking_items(booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number)
        SELECT $1,$2,$3,id,75000,'INR','=Saved section',row_label,seat_number FROM venue_seats WHERE id=ANY($4::uuid[])`,[b,r,f.show,seats]);
      await admin.query('UPDATE bookings SET sealed_at=clock_timestamp() WHERE id=$1',[b]);
      const p=(await admin.query("INSERT INTO payment_attempts(reservation_id,user_id,show_id,amount_minor,currency) VALUES($1,$2,$3,$4,'INR') RETURNING *",[r,f.user,f.show,total])).rows[0];
      await admin.query("UPDATE payment_attempts SET provider_payment_id=$2,status='SUCCEEDED',resolution='BOOKED',booking_id=$3,succeeded_at=clock_timestamp() WHERE id=$1",[p.id,'sim_report_'+p.id,b]);
      if(n<2){await admin.query("UPDATE bookings SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=$1",[b]);
        const refund=(await admin.query("INSERT INTO refunds(payment_attempt_id,amount_minor,currency,reason) VALUES($1,$2,'INR','CUSTOMER_CANCELLED') RETURNING *",[p.id,total])).rows[0];refunds.push(refund);
        await admin.query("INSERT INTO outbox_events(kind,refund_id,operation_key) VALUES('REFUND_CREATE',$1,$2)",[refund.id,refund.request_key]);}
      if(n===2)await admin.query('INSERT INTO ticket_checkins(booking_item_id,show_id,organizer_id,checked_by,request_key) SELECT id,show_id,$2,$3,$4 FROM booking_items WHERE booking_id=$1',[b,show.organizer_id,staff.user,randomUUID()]);
    }
    const jobs=await claimOutbox(admin,{workerId:'report-fixture',batchSize:2,kinds:['REFUND_CREATE']});
    for(const job of jobs){if(job.refund_id===refunds[0].id){await admin.query("UPDATE refunds SET status='PROCESSING' WHERE id=$1",[job.refund_id]);
      await admin.query("UPDATE refunds SET status='SUCCEEDED',provider_refund_id='sim_report_completed',completed_at=clock_timestamp() WHERE id=$1",[job.refund_id]);assert.equal(await acknowledgeOutbox(admin,job.id,job.lease_token),true);
    }else assert.equal(await failOutbox(admin,job.id,job.lease_token,{code:'REPORT_REVIEW',retryable:false}),true);}
    const emptyShow=(await admin.query('INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,$4) RETURNING id',[show.event_id,show.venue_id,show.organizer_id,'2030-01-02T18:00:00Z'])).rows[0].id;
    await admin.query('COMMIT');const url=new URL(original);url.searchParams.set('options',`-c search_path=${schema},public`);pool=createPool(url.toString());
    server=createApp({pool,config:{NODE_ENV:'test',AUTH_SECRET:secret,PUBLIC_ORIGIN:'http://127.0.0.1'},logger:{info(){},error(){}}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}`,scope={organizationId:show.organizer_id,eventId:show.event_id,showId:f.show};
    const options=(who=owner)=>({...scope,fetchImpl:(path,o={})=>fetch(base+path,{...o,headers:{Cookie:`seatledger_session=${who.token}`}})});
    const summary=await operationsRequest('summary',options());
    assert.deepEqual(summary.inventory,{total:2,available:2,held:0,booked:0,expiredHolds:0});
    assert.deepEqual(summary.bookings,{confirmed:20,cancelled:2});assert.deepEqual(summary.attendance,{confirmedSeats:20,checkedInSeats:1});
    assert.deepEqual(summary.financials,[{currency:'INR',capturedMinor:'1725000',confirmedRefundMinor:'150000',unconfirmedRefundMinor:'75000',refundReviewCount:1}]);
    const first=await operationsRequest('bookings',options()),secondPage=await operationsRequest('bookings',{...options(),cursor:first.nextCursor});
    assert.equal(first.items.length,20);assert.deepEqual([...first.items,...secondPage.items].map(b=>b.id),ids.sort());assert.equal(secondPage.nextCursor,null);
    assert.equal([...first.items,...secondPage.items].reduce((n,b)=>n+b.seats.length,0),23);
    const exported=await operationsRequest('export',{...options(),role:'OWNER'});assert.equal(exported.rowCount,20);assert.equal(exported.nextCursor,first.nextCursor);
    assert.ok(exported.csv.includes(`"'  =SUM(1,2)  ""quoted"""`));assert.ok(exported.csv.includes(`'=Saved section`));
    assert.ok(exported.csv.includes('"total_minor","currency"'));
    const tail=await operationsRequest('export',{...options(),role:'OWNER',cursor:first.nextCursor});assert.equal(tail.rowCount,2);assert.equal(tail.nextCursor,null);
    const staffSummary=await operationsRequest('summary',options(staff));assert.equal(staffSummary.financials,null);
    const staffRows=await operationsRequest('bookings',options(staff));assert.ok(staffRows.items.every(b=>b.totalMinor===null&&b.currency===null));
    const staffExport=await operationsRequest('export',{...options(staff),role:'STAFF'});assert.ok(!staffExport.csv.includes('total_minor'));assert.ok(!staffExport.csv.includes('currency'));
    const empty=await operationsRequest('summary',{...options(),showId:emptyShow});assert.deepEqual(empty.financials,[]);assert.equal(empty.inventory.total,0);
    const emptyRows=await operationsRequest('bookings',{...options(),showId:emptyShow});assert.deepEqual(emptyRows.items,[]);assert.equal(emptyRows.nextCursor,null);
    const path=`/api/organizers/${scope.organizationId}/events/${scope.eventId}/shows/${f.show}/operations`;
    const response=await options().fetchImpl(path);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(base+path)).status,401);await assert.rejects(operationsRequest('summary',options(outsider)),e=>e.status===404);
    await assert.rejects(operationsRequest('summary',{...options(),showId:randomUUID()}),e=>e.status===404);
    for(const suffix of ['?owner=other','/bookings?cursor=bad','/bookings?cursor=a&cursor=b'])assert.equal((await options().fetchImpl(path+suffix)).status,400);
    const before=(await pool.query('SELECT (SELECT count(*) FROM audit_events) AS audits,(SELECT count(*) FROM refunds) AS refunds,(SELECT count(*) FROM bookings) AS bookings')).rows[0];
    await operationsRequest('summary',options());await operationsRequest('export',options());
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM audit_events) AS audits,(SELECT count(*) FROM refunds) AS refunds,(SELECT count(*) FROM bookings) AS bookings')).rows[0],before);
    const serialized=JSON.stringify(first)+exported.csv;for(const field of ['token_hash','provider_payment_id','request_key','credential','@test.invalid'])assert.ok(!serialized.includes(field));
    await pool.query("UPDATE organizer_memberships SET role='STAFF' WHERE organizer_id=$1 AND user_id=$2",[scope.organizationId,owner.user]);
    assert.equal((await operationsRequest('summary',options())).financials,null);
    await pool.query('UPDATE organizer_memberships SET revoked_at=clock_timestamp() WHERE organizer_id=$1 AND user_id=$2',[scope.organizationId,owner.user]);
    await assert.rejects(operationsRequest('export',options()),e=>e.status===404);
    await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1",[scope.organizationId]);
    await assert.rejects(operationsRequest('summary',options(staff)),e=>e.status===403);
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[digest(staff.token)]);
    await assert.rejects(operationsRequest('summary',options(staff)),e=>e.status===401);
  }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(pool)await pool.end();if(admin){await admin.query('ROLLBACK');if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}admin.release();}await adminPool.end();}
});
