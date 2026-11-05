import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { sessionCookie } from '../auth/security.js';
import { lockOrganizationAccess } from './service.js';
import { reservationId, parseReservationValue as parse } from '../reservations/commands.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../reliability/history-cursor.js';
import { HttpError } from '../http-error.js';

const stamp = c => `to_char((${c}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const empty = z.object({}).strict(), page = z.object({ cursor:z.string().max(512).optional() }).strict();
async function lockScope(db,session,organizationId,eventId,showId) {
  const organization = await lockOrganizationAccess(db,session,organizationId);
  const event = (await db.query('SELECT id,title,status FROM events WHERE id=$1 AND organizer_id=$2 FOR SHARE',[eventId,organizationId])).rows[0];
  if(!event)throw new HttpError(404,'NOT_FOUND');
  const show = (await db.query(`SELECT id,status,${stamp('starts_at')} AS "startsAt" FROM shows
    WHERE id=$1 AND event_id=$2 AND organizer_id=$3 FOR SHARE`,[showId,eventId,organizationId])).rows[0];
  if(!show)throw new HttpError(404,'NOT_FOUND');
  return { organization,event,show };
}

export async function readOperationsSummary(db,scope) {
  const {show,organization}=scope;
  // Independent aggregates: no booking/item/payment join can multiply money.
  const row=(await db.query(`WITH now AS MATERIALIZED(SELECT clock_timestamp() AS at),
    inventory AS (SELECT count(*)::int AS total,count(*) FILTER(WHERE state='AVAILABLE')::int AS available,
      count(*) FILTER(WHERE state='HELD')::int AS held,count(*) FILTER(WHERE state='BOOKED')::int AS booked,
      count(*) FILTER(WHERE state='HELD' AND expires_at<=now.at)::int AS "expiredHolds"
      FROM show_seats CROSS JOIN now WHERE show_id=$1),
    booking_counts AS (SELECT count(*) FILTER(WHERE status='CONFIRMED')::int AS confirmed,
      count(*) FILTER(WHERE status='CANCELLED')::int AS cancelled FROM bookings WHERE show_id=$1),
    seat_counts AS (SELECT count(*) FILTER(WHERE b.status='CONFIRMED')::int AS "confirmedSeats",
      count(*) FILTER(WHERE c.booking_item_id IS NOT NULL)::int AS "checkedInSeats"
      FROM booking_items i JOIN bookings b ON b.id=i.booking_id LEFT JOIN ticket_checkins c ON c.booking_item_id=i.id WHERE b.show_id=$1),
    money AS (SELECT p.currency,coalesce(sum(p.amount_minor),0)::text AS "capturedMinor",
      coalesce(sum(f.amount_minor) FILTER(WHERE f.status='SUCCEEDED' AND o.status='SUCCEEDED'),0)::text AS "confirmedRefundMinor",
      coalesce(sum(f.amount_minor) FILTER(WHERE f.id IS NOT NULL AND NOT(f.status='SUCCEEDED' AND o.status IS NOT DISTINCT FROM 'SUCCEEDED')),0)::text AS "unconfirmedRefundMinor",
      count(*) FILTER(WHERE f.id IS NOT NULL AND (o.id IS NULL OR o.status='DEAD_LETTER'
        OR (o.status='SUCCEEDED' AND f.status<>'SUCCEEDED') OR (f.status='SUCCEEDED' AND o.status IS DISTINCT FROM 'SUCCEEDED')
        OR (o.status='PROCESSING' AND o.lease_expires_at<=now.at AND o.attempt_count>=o.max_attempts)))::int AS "refundReviewCount"
      FROM payment_attempts p LEFT JOIN refunds f ON f.payment_attempt_id=p.id
      LEFT JOIN outbox_events o ON o.refund_id=f.id AND o.operation_key=f.request_key AND o.kind='REFUND_CREATE' CROSS JOIN now
      WHERE p.show_id=$1 AND p.status='SUCCEEDED' AND $2::boolean GROUP BY p.currency ORDER BY p.currency LIMIT 21)
    SELECT ${stamp('now.at')} AS "asOf",to_jsonb(inventory) AS inventory,to_jsonb(booking_counts) AS bookings,
      to_jsonb(seat_counts) AS attendance,CASE WHEN $2::boolean THEN coalesce((SELECT jsonb_agg(to_jsonb(money) ORDER BY currency) FROM money),'[]'::jsonb) ELSE NULL END AS financials
    FROM now CROSS JOIN inventory CROSS JOIN booking_counts CROSS JOIN seat_counts`,[show.id,organization.role==='OWNER'])).rows[0];
  if(row.financials?.length>20)throw new HttpError(409,'REPORT_CURRENCY_LIMIT');
  return { ...scope,...row,paymentMode:'simulated' };
}

export async function readOperationsBookings(db,scope,cursor) {
  const after=decodeHistoryCursor(cursor),owner=scope.organization.role==='OWNER';
  const result=(await db.query(`WITH now AS MATERIALIZED(SELECT clock_timestamp() AS at),
    headers AS MATERIALIZED(SELECT b.* FROM bookings b WHERE b.show_id=$1
      AND ($2::timestamptz IS NULL OR b.created_at<$2::timestamptz OR (b.created_at=$2::timestamptz AND b.id>$3::uuid))
      ORDER BY b.created_at DESC,b.id ASC LIMIT 21),
    page AS (SELECT b.id,b.status,${stamp('b.created_at')} AS "createdAt",u.display_name AS "customerName",
      CASE WHEN $4::boolean THEN b.total_minor ELSE NULL END AS "totalMinor",CASE WHEN $4::boolean THEN b.currency ELSE NULL END AS currency,
      (SELECT count(*)::int FROM ticket_checkins c JOIN booking_items i ON i.id=c.booking_item_id WHERE i.booking_id=b.id) AS "checkedInSeats",
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.venue_seat_id,'section',i.section_name,'row',i.row_label,'number',i.seat_number) ORDER BY i.venue_seat_id),'[]'::jsonb)
        FROM booking_items i WHERE i.booking_id=b.id) AS seats FROM headers b JOIN users u ON u.id=b.user_id)
    SELECT ${stamp('now.at')} AS "asOf",coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "createdAt" DESC,id) FROM page),'[]'::jsonb) AS items FROM now`,
  [scope.show.id,after?.at??null,after?.id??null,owner])).rows[0];
  const items=result.items.slice(0,20);
  return { ...scope,asOf:result.asOf,items,nextCursor:result.items.length>20?encodeHistoryCursor(items.at(-1)):null,paymentMode:'simulated' };
}

// Quote every cell; prefix every untrusted text cell, even if whitespace precedes
// a formula marker. Numeric cells are our validated, nonnegative integer facts.
export function csvCell(value) {
  const raw=typeof value==='number' ? String(value) : "'"+String(value??'').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ');
  return '"'+raw.replaceAll('"','""')+'"';
}
export function operationsCsv(report) {
  const owner=report.organization.role==='OWNER';
  const header=['snapshot_utc','booking_id','booking_status','created_at_utc','current_customer_name','seat_count','checked_in_seats','saved_seat_labels',...(owner?['total_minor','currency']:[])];
  const rows=report.items.map(b=>[report.asOf,b.id,b.status,b.createdAt,b.customerName,b.seats.length,b.checkedInSeats,
    b.seats.map(s=>`${s.section} / ${s.row} / ${s.number}`).join('; '),...(owner?[b.totalMinor,b.currency]:[])]);
  return '\uFEFF'+[header.map(v=>'"'+v+'"').join(','),...rows.map(row=>row.map(csvCell).join(','))].join('\r\n')+'\r\n';
}

export function createOperationsRouter({pool,config}) {
  const router=Router(),path='/organizers/:organizationId/events/:eventId/shows/:showId/operations';
  router.use(path,(req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();});
  const run=action=>async(req,res)=>{
    const report=await withAuthorizedSession(pool,config,sessionCookie(req,config),async(db,session)=>{
      const query=parse(action==='summary'?empty:page,req.query);
      const ids=['organizationId','eventId','showId'].map(key=>parse(reservationId,req.params[key],true));
      const scope=await lockScope(db,session,...ids);
      return action==='summary'?readOperationsSummary(db,scope):readOperationsBookings(db,scope,query.cursor);
    });
    if(action!=='export'){res.json(report);return;}
    res.set('Content-Disposition',`attachment; filename="seatledger-bookings-${report.show.id}.csv"`);
    res.set('X-Show-Id',report.show.id);res.set('X-Report-Role',report.organization.role);
    res.set('X-As-Of',report.asOf);res.set('X-Export-Row-Count',String(report.items.length));res.set('X-Next-Cursor',report.nextCursor??'');
    res.type('text/csv').send(operationsCsv(report));
  };
  router.get(path,run('summary'));router.get(path+'/bookings',run('bookings'));router.get(path+'/export',run('export'));
  return router;
}
