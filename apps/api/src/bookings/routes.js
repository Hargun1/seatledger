import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { sessionCookie } from '../auth/security.js';
import { reservationId, parseReservationValue as parse } from '../reservations/commands.js';
import { HttpError } from '../http-error.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../reliability/history-cursor.js';

const stamp = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const decodeBookingCursor = decodeHistoryCursor;
const fields = `b.id,b.reservation_id AS "reservationId",b.show_id AS "showId",b.status,b.total_minor::text AS total,b.currency,
  ${stamp('b.created_at')} AS "createdAt",${stamp('b.cancelled_at')} AS "cancelledAt",
  (SELECT count(*)::int FROM booking_items i WHERE i.booking_id=b.id) AS "seatCount",
  jsonb_build_object('eventId',e.id,'title',e.title,'eventStatus',e.status,'startsAt',${stamp('s.starts_at')},
    'venue',v.name,'city',v.city,'timezone',v.timezone,'current',true) AS "currentProgramme"`;
const joins = 'FROM bookings b JOIN shows s ON s.id=b.show_id JOIN events e ON e.id=s.event_id JOIN venues v ON v.id=s.venue_id';
function present(row) { const { total, ...value } = row; return { ...value, totalMinor: Number(total), paymentMode: 'simulated' }; }
export function createBookingRouter({ pool, config }) {
  const router = Router();
  router.use('/bookings', (req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  router.get('/bookings', async (req,res) => {
    const body = await withAuthorizedSession(pool,config,sessionCookie(req,config),async(db,session) => {
      const { cursor } = parse(z.object({ cursor:z.string().max(512).optional() }).strict(),req.query), after=decodeBookingCursor(cursor);
      const rows=(await db.query(`SELECT ${fields} ${joins} WHERE b.user_id=$1 AND b.sealed_at IS NOT NULL
        AND ($2::timestamptz IS NULL OR b.created_at<$2::timestamptz OR (b.created_at=$2::timestamptz AND b.id>$3::uuid))
        ORDER BY b.created_at DESC,b.id ASC LIMIT 21`,[session.user.id,after?.at??null,after?.id??null])).rows;
      const items=rows.slice(0,20).map(present),last=items.at(-1);
      return { items,nextCursor:rows.length>20?encodeHistoryCursor(last):null,paymentMode:'simulated' };
    });res.json(body);
  });
  router.get('/bookings/:id',async(req,res) => {
    const body=await withAuthorizedSession(pool,config,sessionCookie(req,config),async(db,session) => {
      parse(z.object({}).strict(),req.query); const id=parse(reservationId,req.params.id,true);
      // One statement snapshot: header/state and immutable seat facts cannot come from different reads.
      const row=(await db.query(`SELECT ${fields},(SELECT jsonb_agg(jsonb_build_object('id',i.venue_seat_id,
        'section',i.section_name,'row',i.row_label,'number',i.seat_number,'priceMinor',i.price_minor,'currency',i.currency)
        ORDER BY i.venue_seat_id) FROM booking_items i WHERE i.booking_id=b.id) AS items ${joins}
        WHERE b.id=$1 AND b.user_id=$2 AND b.sealed_at IS NOT NULL`,[id,session.user.id])).rows[0];
      if(!row)throw new HttpError(404,'NOT_FOUND');return present(row);
    });res.json(body);
  });return router;
}
