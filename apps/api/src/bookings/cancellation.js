import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { sessionCookie, browserMutation, verifyCsrf } from '../auth/security.js';
import { reservationId, parseReservationValue as parse } from '../reservations/commands.js';
import { lockShowGate, lockShowSeats } from '../reservations/service.js';
import { HttpError } from '../http-error.js';
import { cancelAllocation } from './cancel-allocation.js';

const empty = z.object({}).strict();
// Group computed timestamps before AT TIME ZONE; otherwise SQL applies it to
// the interval operand in a timestamp-minus-interval expression.
const stamp = c => `to_char((${c}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export function cancellationPolicy(config) {
  const minutes = config.CUSTOMER_CANCELLATION_CUTOFF_MINUTES ?? 60;
  if (!Number.isInteger(minutes) || minutes<0 || minutes>10080) throw new TypeError('Invalid cancellation configuration');
  return Object.freeze({ version: 'customer-cancel-v1', cutoffMinutes: minutes, refund: 'FULL', paymentMode: 'simulated' });
}

// Advisory owned snapshot. Financial history survives catalogue/sales changes.
export async function readCancellation(db, userId, bookingId, policy) {
  const row = (await db.query(`WITH now AS MATERIALIZED(SELECT clock_timestamp() AS at)
    SELECT b.id AS "bookingId",b.status,${stamp('b.cancelled_at')} AS "cancelledAt",
      ${stamp("s.starts_at-($3::int*interval '1 minute')")} AS deadline,
      p.id AS "paymentId",f.id AS "refundId",
      CASE WHEN b.status='CANCELLED' THEN 'ALREADY_CANCELLED'
        WHEN s.status<>'SCHEDULED' OR e.status='CANCELLED' THEN 'UNAVAILABLE'
        WHEN s.starts_at-($3::int*interval '1 minute')<=now.at THEN 'CUTOFF_PASSED'
        WHEN EXISTS(SELECT 1 FROM ticket_checkins c JOIN booking_items i ON i.id=c.booking_item_id WHERE i.booking_id=b.id) THEN 'ALREADY_USED'
        WHEN b.sealed_at IS NULL OR r.status<>'CONFIRMED' OR p.id IS NULL OR f.id IS NOT NULL
          OR (SELECT count(*) FROM booking_items WHERE booking_id=b.id) NOT BETWEEN 1 AND 8
          OR EXISTS(SELECT 1 FROM booking_items i LEFT JOIN show_seats stock ON stock.show_id=i.show_id AND stock.venue_seat_id=i.venue_seat_id
            WHERE i.booking_id=b.id AND (stock.state IS DISTINCT FROM 'BOOKED' OR stock.booking_id IS DISTINCT FROM b.id OR stock.reservation_id IS DISTINCT FROM b.reservation_id)) THEN 'REVIEW_REQUIRED'
        ELSE 'ELIGIBLE' END AS reason
    FROM bookings b JOIN reservations r ON r.id=b.reservation_id JOIN shows s ON s.id=b.show_id JOIN events e ON e.id=s.event_id
    LEFT JOIN payment_attempts p ON p.booking_id=b.id AND p.status='SUCCEEDED' AND p.resolution='BOOKED'
    LEFT JOIN refunds f ON f.payment_attempt_id=p.id CROSS JOIN now
    WHERE b.id=$1 AND b.user_id=$2`, [bookingId,userId,policy.cutoffMinutes])).rows[0];
  if (!row) throw new HttpError(404,'NOT_FOUND');
  return { ...row, eligible: row.reason==='ELIGIBLE', policy, paymentMode: 'simulated' };
}

// Natural idempotency: one full cancellation per immutable booking identity.
// Caller owns authorized transaction; no provider call occurs under these locks.
export async function cancelBooking(db, userId, bookingId, policy) {
  const initial = (await db.query('SELECT show_id,reservation_id FROM bookings WHERE id=$1 AND user_id=$2',[bookingId,userId])).rows[0];
  if (!initial) throw new HttpError(404,'NOT_FOUND');
  await lockShowGate(db,initial.show_id,false);
  const items = (await db.query('SELECT venue_seat_id FROM booking_items WHERE booking_id=$1 ORDER BY venue_seat_id',[bookingId])).rows;
  if (items.length<1 || items.length>8) throw new HttpError(409,'CANCELLATION_REVIEW_REQUIRED');
  const stock = await lockShowSeats(db,initial.show_id,items.map(i=>i.venue_seat_id));
  await db.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE',[initial.reservation_id]);
  await db.query('SELECT id FROM bookings WHERE id=$1 AND user_id=$2 FOR UPDATE',[bookingId,userId]);
  await db.query('SELECT id FROM payment_attempts WHERE booking_id=$1 ORDER BY id FOR UPDATE',[bookingId]);
  const current = await readCancellation(db,userId,bookingId,policy);
  if (current.status==='CANCELLED') return current; // Never touches a newer holder's stock.
  if (!current.eligible || stock.length!==items.length) throw new HttpError(409,'CANCELLATION_UNAVAILABLE');
  await cancelAllocation(db,{bookingId,showId:initial.show_id,reservationId:initial.reservation_id,seatIds:items.map(i=>i.venue_seat_id),
    paymentId:current.paymentId,reason:'CUSTOMER_CANCELLED',userId,metadata:{cutoffMinutes:policy.cutoffMinutes,policyVersion:policy.version}});
  const result = await readCancellation(db,userId,bookingId,policy);
  // SQL time remains authoritative AFTER writes/audit/readback; preserve exact deadline.
  if (!(await db.query('SELECT clock_timestamp()<$1::timestamptz AS valid',[current.deadline])).rows[0].valid)
    throw new HttpError(409,'CANCELLATION_UNAVAILABLE');
  return result;
}

export function createCancellationRouter({ pool, config }) {
  const router = Router(), policy = cancellationPolicy(config), path = '/bookings/:id/cancellation';
  router.use(['/booking-policy',path],(req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get('/booking-policy',(req,res)=>{parse(empty,req.query);res.json(policy);});
  router.get(path,async(req,res)=>{
    const body = await withAuthorizedSession(pool,config,sessionCookie(req,config),(db,session)=>{
      parse(empty,req.query);return readCancellation(db,session.user.id,parse(reservationId,req.params.id,true),policy);
    });res.json(body);
  });
  router.post(path,browserMutation(config),async(req,res)=>{
    const body = await withAuthorizedSession(pool,config,sessionCookie(req,config),(db,session)=>{
      verifyCsrf(req,session);parse(empty,req.query);parse(empty,req.body);
      return cancelBooking(db,session.user.id,parse(reservationId,req.params.id,true),policy);
    });res.json(body);
  });return router;
}
