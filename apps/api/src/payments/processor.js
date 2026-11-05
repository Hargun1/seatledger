import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lockShowGate, lockShowSeats } from '../reservations/service.js';
import { encodeSimulatedEvent } from './events.js';
import { readSimulatedEventMapping, classifySimulatedEvent } from './inbox.js';

async function transaction(pool,work) {
  const db=await pool.connect();let discard=false;
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT set_config($1,$2,true),set_config($3,$4,true)',['lock_timeout','250ms','statement_timeout','1500ms']);
    const result=await work(db);await db.query('COMMIT');return result;
  } catch(error) {
    await db.query('ROLLBACK').catch(()=>{discard=true;});
    discard ||= error.code?.startsWith('08') || error.message==='Query read timeout';throw error;
  } finally {db.release(discard?new Error('Payment processor connection unavailable'):undefined);}
}
function readEvidence(row) {
  try {
    const event=JSON.parse(row.event_body.toString('utf8'));
    if(!row.event_body.equals(encodeSimulatedEvent(event)) || !row.payload_hash.equals(createHash('sha256').update(row.event_body).digest())
      || row.provider_event_id!==event.eventId || row.payment_attempt_id!==event.paymentAttemptId
      || row.provider_payment_id!==event.providerPaymentId || row.kind!==event.kind
      || Number(row.amount_minor)!==event.amountMinor || row.currency!==event.currency
      || row.occurred_at?.toISOString()!==event.occurredAt) return null;
    return event;
  } catch {return null;}
}
async function finishEvent(db,id,reason=null) {
  await db.query(`UPDATE payment_events SET status=CASE WHEN $2::text IS NULL THEN 'PROCESSED' ELSE 'REJECTED' END,
    processed_at=clock_timestamp(),rejection_code=$2,processing_attempts=processing_attempts+1,last_error_code=NULL
    WHERE id=$1 AND status='RECEIVED'`,[id,reason]);
}
async function compensate(db,pay,event,reason) {
  await db.query(`UPDATE payment_attempts SET provider_payment_id=$2,status='SUCCEEDED',resolution='REFUND_REQUIRED',
    booking_id=NULL,succeeded_at=clock_timestamp() WHERE id=$1`,[pay.id,event.providerPaymentId]);
  const refund=(await db.query(`INSERT INTO refunds(payment_attempt_id,amount_minor,currency,reason)
    SELECT id,amount_minor,currency,$2 FROM payment_attempts WHERE id=$1 RETURNING id,request_key`,[pay.id,reason])).rows[0];
  await db.query(`INSERT INTO outbox_events(kind,refund_id,operation_key,payload)
    VALUES('REFUND_CREATE',$1,$2,$3::jsonb)`,[refund.id,refund.request_key,JSON.stringify({paymentMode:'simulated'})]);
}
async function createBooking(db,res,pay,event,itemCount) {
  await db.query("UPDATE reservations SET status='CONFIRMED',closed_at=clock_timestamp() WHERE id=$1",[res.id]);
  const booking=(await db.query(`INSERT INTO bookings(reservation_id,user_id,show_id,total_minor,currency)
    SELECT id,user_id,show_id,total_minor,currency FROM reservations WHERE id=$1 RETURNING id`,[res.id])).rows[0];
  const items=await db.query(`INSERT INTO booking_items(booking_id,reservation_id,show_id,venue_seat_id,price_minor,currency,section_name,row_label,seat_number)
    SELECT $1,i.reservation_id,i.show_id,i.venue_seat_id,i.price_minor,i.currency,section.name,seat.row_label,seat.seat_number
    FROM reservation_items i JOIN venue_seats seat ON seat.id=i.venue_seat_id JOIN venue_sections section ON section.id=seat.section_id
    WHERE i.reservation_id=$2 ORDER BY i.venue_seat_id`,[booking.id,res.id]);
  if(items.rowCount!==itemCount)throw new Error('Incomplete booking snapshot');
  await db.query('UPDATE bookings SET sealed_at=clock_timestamp() WHERE id=$1',[booking.id]);
  const stock=await db.query(`UPDATE show_seats SET state='BOOKED',booking_id=$2,expires_at=NULL
    WHERE show_id=$3 AND reservation_id=$1 AND state='HELD'`,[res.id,booking.id,res.show_id]);
  if(stock.rowCount!==itemCount)throw new Error('Incomplete booking allocation');
  await db.query(`UPDATE payment_attempts SET provider_payment_id=$2,status='SUCCEEDED',resolution='BOOKED',
    booking_id=$3,succeeded_at=clock_timestamp() WHERE id=$1`,[pay.id,event.providerPaymentId,booking.id]);
  return booking.id;
}

export async function processPaymentEvent(pool,id) {
  if(!z.uuid().safeParse(id).success)throw new TypeError('Invalid inbox identity');
  return transaction(pool,async db=>{
    // Discovery only: never claim/lock an inbox or parent row before stock.
    const initial=(await db.query(`SELECT p.id,p.reservation_id,p.show_id FROM payment_events e
      JOIN payment_attempts p ON p.id=e.payment_attempt_id WHERE e.id=$1 AND e.status='RECEIVED' AND e.event_body IS NOT NULL`,[id])).rows[0];
    if(!initial)return {outcome:'skipped'};
    await lockShowGate(db,initial.show_id,false);
    const items=(await db.query('SELECT venue_seat_id FROM reservation_items WHERE reservation_id=$1 ORDER BY venue_seat_id',[initial.reservation_id])).rows;
    const stock=await lockShowSeats(db,initial.show_id,items.map(item=>item.venue_seat_id));
    if(items.length<1 || items.length>8 || stock.length!==items.length)throw new Error('Invalid confirmation agreement');
    const res=(await db.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE',[initial.reservation_id])).rows[0];
    const existing=(await db.query('SELECT id FROM bookings WHERE reservation_id=$1 FOR UPDATE',[res.id])).rows[0];
    const pay=(await db.query('SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE',[initial.id])).rows[0];
    const saved=(await db.query('SELECT * FROM payment_events WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(saved.status!=='RECEIVED')return {outcome:'skipped'};
    const due=(await db.query('SELECT next_attempt_at<=clock_timestamp() AS due FROM payment_events WHERE id=$1',[id])).rows[0].due;
    if(!due)return {outcome:'skipped'};
    const event=readEvidence(saved),mapping=await readSimulatedEventMapping(db,pay.id);
    const invalid=!event?'EVENT_EVIDENCE_INVALID':classifySimulatedEvent(mapping,event,saved.event_body);
    if(invalid){await finishEvent(db,id,invalid);return {outcome:'rejected'};}
    if(pay.status==='SUCCEEDED'){await finishEvent(db,id);return {outcome:'ignored'};}
    if(event.kind!=='PAYMENT_SUCCEEDED') {
      await db.query(`UPDATE payment_attempts SET provider_payment_id=$2,status=CASE
        WHEN $3='PAYMENT_FAILED' THEN 'FAILED' WHEN status='CREATED' THEN 'PENDING' ELSE status END WHERE id=$1`,[pay.id,event.providerPaymentId,event.kind]);
      await finishEvent(db,id);return {outcome:event.kind==='PAYMENT_FAILED'?'failedPayment':'pending'};
    }
    // Separate fresh SQL clock AFTER every lock/wait. No JS deadline authority.
    const check=(await db.query(`WITH now AS MATERIALIZED(SELECT clock_timestamp() AS at)
      SELECT r.expires_at<=now.at AS expired,
        r.status='ACTIVE' AND r.sealed_at IS NOT NULL AND r.expires_at>now.at AND s.starts_at>now.at
        AND s.status='SCHEDULED' AND e.status='PUBLISHED' AND o.status='APPROVED'
        AND NOT EXISTS(SELECT 1 FROM reservation_items i LEFT JOIN show_seats stock ON stock.show_id=i.show_id AND stock.venue_seat_id=i.venue_seat_id
          WHERE i.reservation_id=r.id AND (stock.state IS DISTINCT FROM 'HELD' OR stock.reservation_id IS DISTINCT FROM r.id
            OR stock.expires_at IS DISTINCT FROM r.expires_at)) AS eligible
      FROM reservations r JOIN shows s ON s.id=r.show_id JOIN events e ON e.id=s.event_id JOIN organizers o ON o.id=s.organizer_id CROSS JOIN now WHERE r.id=$1`,[res.id])).rows[0];
    if(existing || !check.eligible) {
      await compensate(db,pay,event,existing?'DUPLICATE_PAYMENT':check.expired?'HOLD_EXPIRED':'INVENTORY_LOST');
      await finishEvent(db,id);return {outcome:'compensated'};
    }
    const bookingId=await createBooking(db,res,pay,event,items.length);
    await finishEvent(db,id);
    // Last decision statement follows ALL business/event writes. A slow write
    // crossing expiry rolls everything back; a later attempt will compensate.
    const final=(await db.query(`WITH now AS MATERIALIZED(SELECT clock_timestamp() AS at)
      SELECT r.expires_at>now.at AND s.starts_at>now.at
        AND NOT EXISTS(SELECT 1 FROM reservation_items i LEFT JOIN show_seats stock ON stock.show_id=i.show_id AND stock.venue_seat_id=i.venue_seat_id
          WHERE i.reservation_id=r.id AND (stock.state IS DISTINCT FROM 'BOOKED' OR stock.booking_id IS DISTINCT FROM $2::uuid
            OR stock.reservation_id IS DISTINCT FROM r.id)) AS valid
      FROM reservations r JOIN shows s ON s.id=r.show_id CROSS JOIN now WHERE r.id=$1`,[res.id,bookingId])).rows[0].valid;
    if(!final){const error=new Error('Confirmation window ended');error.code='BOOKING_WINDOW_CLOSED';throw error;}
    return {outcome:'booked'};
  });
}

export async function runInboxBatch(pool,{batchSize=10,retryDelaySeconds=5,signal}={}) {
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>50||!Number.isInteger(retryDelaySeconds)||retryDelaySeconds<0||retryDelaySeconds>3600)
    throw new TypeError('Invalid inbox processor configuration');
  const counts={selected:0,attempted:0,processed:0,booked:0,compensated:0,pending:0,failedPayment:0,ignored:0,rejected:0,skipped:0,busy:0,failed:0};
  if(signal?.aborted)return counts;
  const rows=(await pool.query(`SELECT id FROM payment_events WHERE status='RECEIVED' AND event_body IS NOT NULL
    AND next_attempt_at<=statement_timestamp() ORDER BY next_attempt_at,id LIMIT $1`,[batchSize])).rows;
  counts.selected=rows.length;
  for(const row of rows) {
    if(signal?.aborted)break;counts.attempted++;
    try {const result=await processPaymentEvent(pool,row.id);counts[result.outcome]++;if(!['skipped','rejected'].includes(result.outcome))counts.processed++;}
    catch(error) {
      if(['55P03','40P01','40001','57014','BOOKING_WINDOW_CLOSED'].includes(error.code))counts.busy++;else counts.failed++;
      try {await transaction(pool,db=>db.query(`UPDATE payment_events SET processing_attempts=processing_attempts+1,
        next_attempt_at=clock_timestamp()+($2::integer*interval '1 second'),last_error_code='PROCESSING_RETRY'
        WHERE id=$1 AND status='RECEIVED'`,[row.id,retryDelaySeconds]));}catch{counts.failed++;}
    }
  }
  return counts;
}
