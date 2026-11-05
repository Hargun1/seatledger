import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {lockShowGate,lockShowSeats} from '../reservations/service.js';
import {cancelAllocation} from '../bookings/cancel-allocation.js';
import {eventCancellationProgress} from './event-cancellation.js';

export class EventCancellationStale extends Error {}
class EventCancellationReview extends Error {}
async function transaction(pool,work){
  const db=await pool.connect();let discard=false;
  try{await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query("SELECT set_config('lock_timeout','250ms',true),set_config('statement_timeout','1500ms',true)");
    const value=await work(db);await db.query('COMMIT');return value;
  }catch(error){await db.query('ROLLBACK').catch(()=>{discard=true;});discard ||= error.code?.startsWith('08')||error.message==='Query read timeout';throw error;}
  finally{db.release(discard?new Error('Event cancellation connection unavailable'):undefined);}
}
async function closedScope(db,job,showId){
  await lockShowGate(db,showId,false);
  const valid=(await db.query("SELECT 1 FROM shows s JOIN events e ON e.id=s.event_id WHERE s.id=$1 AND e.id=$2 AND e.status='CANCELLED'",[showId,job.event_id])).rowCount;
  if(!valid)throw new EventCancellationReview();
}
// Last lock after business writes: fences pause/resume without taking a job lock
// before stock. Metadata writers never acquire stock after the job row.
async function pinJob(db,job){
  const current=(await db.query('SELECT status,generation FROM event_cancellation_jobs WHERE event_id=$1 FOR SHARE',[job.event_id])).rows[0];
  if(!current||current.generation!==job.generation||!['PENDING','PROCESSING'].includes(current.status))throw new EventCancellationStale();
}
export async function cancelEventBooking(pool,job,bookingId){
  return transaction(pool,async db=>{
    const initial=(await db.query('SELECT show_id,reservation_id FROM bookings WHERE id=$1',[bookingId])).rows[0];if(!initial)return false;
    await closedScope(db,job,initial.show_id);
    const items=(await db.query('SELECT venue_seat_id FROM booking_items WHERE booking_id=$1 ORDER BY venue_seat_id',[bookingId])).rows;
    if(items.length<1||items.length>8)throw new EventCancellationReview();
    const stock=await lockShowSeats(db,initial.show_id,items.map(i=>i.venue_seat_id));
    await db.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE',[initial.reservation_id]);
    const booking=(await db.query('SELECT status FROM bookings WHERE id=$1 FOR UPDATE',[bookingId])).rows[0];
    const pay=(await db.query("SELECT id FROM payment_attempts WHERE booking_id=$1 AND status='SUCCEEDED' AND resolution='BOOKED' ORDER BY id FOR UPDATE",[bookingId])).rows[0];
    if(booking.status==='CANCELLED')return false;
    const valid=(await db.query(`SELECT b.sealed_at IS NOT NULL AND r.status='CONFIRMED'
      AND NOT EXISTS(SELECT 1 FROM ticket_checkins c JOIN booking_items i ON i.id=c.booking_item_id WHERE i.booking_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM booking_items i LEFT JOIN show_seats s ON s.show_id=i.show_id AND s.venue_seat_id=i.venue_seat_id
        WHERE i.booking_id=b.id AND (s.state IS DISTINCT FROM 'BOOKED' OR s.booking_id IS DISTINCT FROM b.id OR s.reservation_id IS DISTINCT FROM b.reservation_id))
      AND NOT EXISTS(SELECT 1 FROM refunds f JOIN payment_attempts p ON p.id=f.payment_attempt_id WHERE p.booking_id=b.id AND p.resolution='BOOKED') AS valid
      FROM bookings b JOIN reservations r ON r.id=b.reservation_id WHERE b.id=$1`,[bookingId])).rows[0]?.valid;
    if(!pay||stock.length!==items.length||!valid)throw new EventCancellationReview();
    await cancelAllocation(db,{bookingId,showId:initial.show_id,reservationId:initial.reservation_id,seatIds:items.map(i=>i.venue_seat_id),paymentId:pay.id,
      reason:'EVENT_CANCELLED',metadata:{eventId:job.event_id,generation:job.generation}});
    await pinJob(db,job);return true;
  });
}
async function releaseEventHold(pool,job,reservationId){
  return transaction(pool,async db=>{
    const initial=(await db.query('SELECT show_id FROM reservations WHERE id=$1',[reservationId])).rows[0];if(!initial)return false;
    await closedScope(db,job,initial.show_id);
    const items=(await db.query('SELECT venue_seat_id FROM reservation_items WHERE reservation_id=$1 ORDER BY venue_seat_id',[reservationId])).rows;
    if(items.length<1||items.length>8)throw new EventCancellationReview();
    if((await lockShowSeats(db,initial.show_id,items.map(i=>i.venue_seat_id))).length!==items.length)throw new EventCancellationReview();
    const current=(await db.query('SELECT status,sealed_at FROM reservations WHERE id=$1 FOR UPDATE',[reservationId])).rows[0];
    if(current.status!=='ACTIVE')return false;if(!current.sealed_at)throw new EventCancellationReview();
    await db.query("UPDATE reservations SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'RELEASED' END,closed_at=clock_timestamp() WHERE id=$1",[reservationId]);
    await db.query("UPDATE show_seats SET state='AVAILABLE',reservation_id=NULL,booking_id=NULL,expires_at=NULL WHERE show_id=$1 AND reservation_id=$2 AND state='HELD'",[initial.show_id,reservationId]);
    await db.query(`INSERT INTO audit_events(operation_id,actor_kind,action,entity_type,entity_id,metadata)
      VALUES($1,'WORKER','event.hold_released','reservation',$2,$3)`,[randomUUID(),reservationId,{eventId:job.event_id,generation:job.generation}]);
    await pinJob(db,job);return true;
  });
}
async function metadata(pool,job,work){
  return transaction(pool,async db=>{
    await db.query('SELECT id FROM events WHERE id=$1 FOR SHARE',[job.event_id]);
    const current=(await db.query('SELECT * FROM event_cancellation_jobs WHERE event_id=$1 FOR UPDATE',[job.event_id])).rows[0];
    if(!current||current.generation!==job.generation||!['PENDING','PROCESSING'].includes(current.status))return null;
    return work(db,current);
  });
}
async function failure(pool,job,error,delay){
  return metadata(pool,job,async(db,current)=>{
    const failures=Math.min(8,current.failed_attempts+1),review=error instanceof EventCancellationReview||failures>=8;
    await db.query(`UPDATE event_cancellation_jobs SET status=$2,failed_attempts=$3,last_error_code=$4,
      next_attempt_at=clock_timestamp()+($5::int*interval '1 second') WHERE event_id=$1`,
    [job.event_id,review?'NEEDS_REVIEW':'PROCESSING',failures,review?'EVENT_CANCELLATION_REVIEW':'EVENT_CANCELLATION_RETRY',delay]);
    return review;
  });
}
const options=z.object({batchSize:z.number().int().min(1).max(20).default(5),retryDelaySeconds:z.number().int().min(0).max(60).default(1)}).strict();
export async function runEventCancellationBatch(pool,{signal,...raw}={}){
  const parsed=options.safeParse(raw);if(!parsed.success)throw new TypeError('Invalid event cancellation batch');
  const {batchSize,retryDelaySeconds}=parsed.data;
  const counts={selected:0,attempted:0,cancelledBookings:0,releasedHolds:0,skipped:0,busy:0,failed:0,needsReview:0,completedJobs:0};
  if(signal?.aborted)return counts;
  // Nonexclusive discovery. Per-allocation natural idempotency coordinates
  // workers; committed job state and generation fence every business completion.
  const job=(await pool.query("SELECT event_id,generation FROM event_cancellation_jobs WHERE status IN ('PENDING','PROCESSING') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,event_id LIMIT 1")).rows[0];
  if(!job)return counts;counts.selected=1;
  const active=await metadata(pool,job,async db=>{
    const event=(await db.query('SELECT status FROM events WHERE id=$1',[job.event_id])).rows[0];
    if(event?.status!=='CANCELLED')throw new EventCancellationReview();
    await db.query("UPDATE event_cancellation_jobs SET status='PROCESSING' WHERE event_id=$1",[job.event_id]);return true;
  }).catch(async error=>{
    if(['55P03','40P01','40001','57014'].includes(error.code)){counts.busy++;return false;}
    counts.failed++;if(await failure(pool,job,error,retryDelaySeconds))counts.needsReview++;return false;
  });
  if(!active)return counts;
  const bookings=(await pool.query("SELECT b.id FROM bookings b JOIN shows s ON s.id=b.show_id WHERE s.event_id=$1 AND b.status='CONFIRMED' ORDER BY b.id LIMIT $2",[job.event_id,batchSize])).rows;
  const holds=bookings.length<batchSize?(await pool.query("SELECT r.id FROM reservations r JOIN shows s ON s.id=r.show_id WHERE s.event_id=$1 AND r.status='ACTIVE' ORDER BY r.id LIMIT $2",[job.event_id,batchSize-bookings.length])).rows:[];
  for(const item of [...bookings.map(v=>({...v,kind:'booking'})),...holds.map(v=>({...v,kind:'hold'}))]){
    if(signal?.aborted)return counts;counts.attempted++;
    try{const changed=await(item.kind==='booking'?cancelEventBooking(pool,job,item.id):releaseEventHold(pool,job,item.id));
      if(changed)counts[item.kind==='booking'?'cancelledBookings':'releasedHolds']++;else counts.skipped++;
    }catch(error){
      if(error instanceof EventCancellationStale){counts.skipped++;return counts;}
      if(['55P03','40P01','40001','57014'].includes(error.code)){counts.busy++;break;}
      counts.failed++;if(await failure(pool,job,error,retryDelaySeconds))counts.needsReview++;return counts;
    }
  }
  const finished=await metadata(pool,job,async db=>{
    const {counts:c}=await eventCancellationProgress(db,job.event_id);
    const clear=c.remainingBookings===0&&c.activeHolds===0;
    if(clear&&(c.remainingAllocations!==0||c.missingRefundIntents!==0)){
      await db.query("UPDATE event_cancellation_jobs SET status='NEEDS_REVIEW',last_error_code='EVENT_CANCELLATION_REVIEW' WHERE event_id=$1",[job.event_id]);return 'review';
    }
    await db.query(`UPDATE event_cancellation_jobs SET status=$2,completed_at=CASE WHEN $2='COMPLETED' THEN clock_timestamp() ELSE NULL END,
      failed_attempts=CASE WHEN $3::boolean THEN 0 ELSE failed_attempts END,last_error_code=CASE WHEN $3::boolean THEN NULL ELSE last_error_code END,
      next_attempt_at=clock_timestamp()+interval '100 milliseconds' WHERE event_id=$1`,
    [job.event_id,clear?'COMPLETED':'PROCESSING',clear||counts.cancelledBookings+counts.releasedHolds>0]);
    return clear?'completed':'pending';
  });
  if(finished==='completed')counts.completedJobs++;if(finished==='review')counts.needsReview++;return counts;
}
