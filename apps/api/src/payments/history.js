import { decodeHistoryCursor, encodeHistoryCursor } from '../reliability/history-cursor.js';

const stamp = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listCustomerPayments(db, userId, cursor) {
  const after = decodeHistoryCursor(cursor);
  const rows = (await db.query(`SELECT p.id,p.reservation_id AS "reservationId",p.show_id AS "showId",
    p.status,p.resolution,p.amount_minor::text AS amount,p.currency,p.booking_id AS "bookingId",
    ${stamp('p.created_at')} AS "createdAt",
    jsonb_build_object('eventId',e.id,'title',e.title,'venue',v.name,'city',v.city,
      'startsAt',${stamp('s.starts_at')},'timezone',v.timezone,'current',true) AS "currentProgramme"
    FROM payment_attempts p JOIN shows s ON s.id=p.show_id
    JOIN events e ON e.id=s.event_id JOIN venues v ON v.id=s.venue_id
    WHERE p.user_id=$1 AND ($2::timestamptz IS NULL OR p.created_at<$2::timestamptz
      OR (p.created_at=$2::timestamptz AND p.id>$3::uuid))
    ORDER BY p.created_at DESC,p.id ASC LIMIT 21`, [userId, after?.at ?? null, after?.id ?? null])).rows;
  const items = rows.slice(0,20).map(({ amount, ...row }) => ({ ...row, amountMinor: Number(amount), paymentMode: 'simulated' }));
  return { items, nextCursor: rows.length>20 ? encodeHistoryCursor(items.at(-1)) : null, paymentMode: 'simulated' };
}
