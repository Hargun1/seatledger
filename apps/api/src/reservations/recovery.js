export const RECOVERY_PAGE_SIZE = 20;

// A recovery read grants no lease. Header, immutable items and CURRENT ownership
// share one statement snapshot; the next write must recheck under row locks.
export async function readCurrentReservations(db, userId, { showId, after }) {
  const row = (await db.query(`WITH candidates AS MATERIALIZED (
    SELECT r.* FROM reservations r
    WHERE r.user_id=$1 AND r.show_id=$2 AND r.status='ACTIVE' AND r.sealed_at IS NOT NULL
      AND r.expires_at>statement_timestamp() AND ($3::uuid IS NULL OR r.id>$3::uuid)
      AND EXISTS (SELECT 1 FROM reservation_items i WHERE i.reservation_id=r.id)
      AND NOT EXISTS (
        SELECT 1 FROM reservation_items i LEFT JOIN show_seats s
          ON s.show_id=i.show_id AND s.venue_seat_id=i.venue_seat_id
        WHERE i.reservation_id=r.id AND (s.state IS DISTINCT FROM 'HELD'
          OR s.reservation_id IS DISTINCT FROM r.id OR s.expires_at IS DISTINCT FROM r.expires_at))
    ORDER BY r.id LIMIT $4
  ) SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOf",
    COALESCE(jsonb_agg(jsonb_build_object(
      'id',r.id,'showId',r.show_id,'status',r.status,'effectiveStatus','ACTIVE',
      'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'currency',r.currency,'totalMinor',r.total_minor,'paymentMode','simulated',
      'items',(SELECT jsonb_agg(jsonb_build_object('id',i.venue_seat_id,'priceMinor',i.price_minor,'currency',i.currency)
        ORDER BY i.venue_seat_id) FROM reservation_items i WHERE i.reservation_id=r.id)
    ) ORDER BY r.id),'[]'::jsonb) AS reservations FROM candidates r`,
  [userId, showId, after ?? null, RECOVERY_PAGE_SIZE + 1])).rows[0];
  const reservations = row.reservations.slice(0, RECOVERY_PAGE_SIZE);
  return { showId, asOf: row.asOf, reservations,
    nextCursor: row.reservations.length > RECOVERY_PAGE_SIZE ? reservations.at(-1).id : null,
    readOnly: true, paymentMode: 'simulated' };
}
