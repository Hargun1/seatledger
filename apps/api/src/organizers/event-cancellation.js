import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {withAuthorizedSession} from '../auth/authorized-transaction.js';
import {sessionCookie,browserMutation,verifyCsrf} from '../auth/security.js';
import {lockOrganizationAccess} from './service.js';
import {reservationId,parseReservationValue as parse} from '../reservations/commands.js';
import {HttpError} from '../http-error.js';

const stamp=c=>`to_char((${c}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const empty=z.object({}).strict(),resumeInput=z.object({expectedGeneration:z.number().int().min(0).max(2147483646)}).strict();
export async function eventCancellationProgress(db,eventId){
  const row=(await db.query(`WITH now AS MATERIALIZED(SELECT clock_timestamp() AS at),
    b AS(SELECT count(*)::int AS "totalBookings",count(*) FILTER(WHERE status='CANCELLED')::int AS "cancelledBookings",
      count(*) FILTER(WHERE status='CONFIRMED')::int AS "remainingBookings" FROM bookings WHERE show_id IN(SELECT id FROM shows WHERE event_id=$1)),
    r AS(SELECT count(*)::int AS "activeHolds" FROM reservations WHERE status='ACTIVE' AND show_id IN(SELECT id FROM shows WHERE event_id=$1)),
    a AS(SELECT count(*)::int AS "remainingAllocations" FROM show_seats WHERE state<>'AVAILABLE' AND show_id IN(SELECT id FROM shows WHERE event_id=$1)),
    c AS(SELECT count(*)::int AS "checkedInSeats" FROM ticket_checkins WHERE show_id IN(SELECT id FROM shows WHERE event_id=$1)),
    coverage AS(SELECT count(*)::int AS "missingRefundIntents" FROM payment_attempts p JOIN bookings b ON b.id=p.booking_id
      WHERE b.status='CANCELLED' AND p.status='SUCCEEDED' AND p.resolution='BOOKED' AND p.show_id IN(SELECT id FROM shows WHERE event_id=$1)
      AND NOT EXISTS(SELECT 1 FROM refunds f JOIN outbox_events o ON o.refund_id=f.id AND o.operation_key=f.request_key AND o.kind='REFUND_CREATE' WHERE f.payment_attempt_id=p.id)),
    money AS(SELECT count(*)::int AS "refundRequests",count(*) FILTER(WHERE f.status='SUCCEEDED' AND o.status='SUCCEEDED')::int AS "refundsCompleted",
      count(*) FILTER(WHERE o.id IS NULL OR o.status='DEAD_LETTER' OR (o.status='SUCCEEDED' AND f.status<>'SUCCEEDED')
        OR (f.status='SUCCEEDED' AND o.status IS DISTINCT FROM 'SUCCEEDED') OR(o.status='PROCESSING' AND o.lease_expires_at<=now.at AND o.attempt_count>=o.max_attempts))::int AS "refundsNeedsReview"
      FROM refunds f JOIN payment_attempts p ON p.id=f.payment_attempt_id LEFT JOIN outbox_events o ON o.refund_id=f.id AND o.operation_key=f.request_key AND o.kind='REFUND_CREATE'
      CROSS JOIN now WHERE p.show_id IN(SELECT id FROM shows WHERE event_id=$1)),
    pending AS(SELECT count(*)::int AS "unresolvedPayments" FROM payment_attempts WHERE status<>'SUCCEEDED' AND show_id IN(SELECT id FROM shows WHERE event_id=$1)),
    schedule AS(SELECT count(*)::int AS n,bool_and(status='SCHEDULED' AND starts_at>now.at) AS valid FROM shows CROSS JOIN now WHERE event_id=$1)
    SELECT ${stamp('now.at')} AS "asOf",to_jsonb(b)||to_jsonb(r)||to_jsonb(a)||to_jsonb(c)||to_jsonb(coverage)||to_jsonb(money)||to_jsonb(pending) AS counts,
      e.status='PUBLISHED' AND schedule.n BETWEEN 1 AND 20 AND coalesce(schedule.valid,false) AND c."checkedInSeats"=0 AND j.event_id IS NULL AS requestable,
      CASE WHEN j.event_id IS NULL THEN NULL ELSE jsonb_build_object('status',j.status,'generation',j.generation,'failedAttempts',j.failed_attempts,
        'requestedAt',${stamp('j.requested_at')},'completedAt',${stamp('j.completed_at')},'lastErrorCode',j.last_error_code) END AS job
    FROM events e CROSS JOIN now CROSS JOIN b CROSS JOIN r CROSS JOIN a CROSS JOIN c CROSS JOIN coverage CROSS JOIN money CROSS JOIN pending CROSS JOIN schedule
    LEFT JOIN event_cancellation_jobs j ON j.event_id=e.id WHERE e.id=$1`,[eventId])).rows[0];
  if(!row)throw new HttpError(404,'NOT_FOUND');return row;
}
async function scope(db,session,organizationId,eventId,write=false){
  const organization=await lockOrganizationAccess(db,session,organizationId,{owner:write});
  const event=(await db.query(`SELECT id,title,status FROM events WHERE id=$1 AND organizer_id=$2 ${write?'FOR UPDATE':'FOR SHARE'}`,[eventId,organizationId])).rows[0];
  if(!event)throw new HttpError(404,'NOT_FOUND');return {organization,event};
}
async function present(db,context){return {...context,...await eventCancellationProgress(db,context.event.id),paymentMode:'simulated'};}
export async function requestEventCancellation(db,session,organizationId,eventId){
  const context=await scope(db,session,organizationId,eventId,true);
  const previous=(await db.query('SELECT event_id FROM event_cancellation_jobs WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0];
  if(previous){if(context.event.status!=='CANCELLED')throw new HttpError(409,'EVENT_CANCELLATION_REVIEW');return present(db,context);}
  const preview=await eventCancellationProgress(db,eventId);
  if(!preview.requestable)throw new HttpError(409,'EVENT_CANCELLATION_UNAVAILABLE');
  const deadline=(await db.query('SELECT min(starts_at)::text AS deadline FROM shows WHERE event_id=$1',[eventId])).rows[0].deadline;
  const job=(await db.query('INSERT INTO event_cancellation_jobs(event_id,organizer_id,requested_by) VALUES($1,$2,$3) RETURNING request_key',[eventId,organizationId,session.user.id])).rows[0];
  await db.query("UPDATE events SET status='CANCELLED' WHERE id=$1",[eventId]);context.event.status='CANCELLED';
  await db.query(`INSERT INTO audit_events(operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,organizer_id,metadata)
    VALUES($1,'USER',$2,'event.cancellation_requested','event',$3,$4,$5)`,[job.request_key,session.user.id,eventId,organizationId,{policy:'future-unadmitted-event-v1'}]);
  const result=await present(db,context);
  if(!(await db.query('SELECT clock_timestamp()<$1::timestamptz AS valid',[deadline])).rows[0].valid)throw new HttpError(409,'EVENT_CANCELLATION_UNAVAILABLE');
  return result;
}
async function resumeEventCancellation(db,session,organizationId,eventId,expectedGeneration){
  const context=await scope(db,session,organizationId,eventId,true);
  const job=(await db.query('SELECT * FROM event_cancellation_jobs WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0];
  if(!job||context.event.status!=='CANCELLED')throw new HttpError(409,'EVENT_CANCELLATION_REVIEW');
  if(job.generation!==expectedGeneration){if(job.generation===expectedGeneration+1)return present(db,context);throw new HttpError(409,'EVENT_CANCELLATION_STALE');}
  if(job.status==='NEEDS_REVIEW'){
    await db.query("UPDATE event_cancellation_jobs SET status='PENDING',generation=generation+1,failed_attempts=0,last_error_code=NULL,next_attempt_at=clock_timestamp() WHERE event_id=$1",[eventId]);
    await db.query(`INSERT INTO audit_events(operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,organizer_id,metadata)
      VALUES($1,'USER',$2,'event.cancellation_resumed','event',$3,$4,$5)`,[randomUUID(),session.user.id,eventId,organizationId,{generation:job.generation+1}]);
  }
  return present(db,context);
}
export function createEventCancellationRouter({pool,config}){
  const router=Router(),path='/organizers/:organizationId/events/:eventId/cancellation';
  router.use(path,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const run=action=>async(req,res)=>{
    const result=await withAuthorizedSession(pool,config,sessionCookie(req,config),async(db,session)=>{
      parse(empty,req.query);if(action!=='read')verifyCsrf(req,session);
      const ids=['organizationId','eventId'].map(k=>parse(reservationId,req.params[k],true));
      if(action==='read')return present(db,await scope(db,session,...ids));
      if(action==='request'){parse(empty,req.body);return requestEventCancellation(db,session,...ids);}
      return resumeEventCancellation(db,session,...ids,parse(resumeInput,req.body).expectedGeneration);
    });res.json(result);
  };
  router.get(path,run('read'));router.post(path,browserMutation(config),run('request'));router.post(path+'/resume',browserMutation(config),run('resume'));
  return router;
}
