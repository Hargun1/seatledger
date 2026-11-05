import { HttpError } from '../http-error.js';

// One statement snapshot of owned payment, business refund and its exact job.
// This reader never claims work, contacts a provider or locks inventory.
export async function readRefundStatus(db, userId, paymentId) {
  const row = (await db.query(`WITH now AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT p.id AS "paymentId", CASE WHEN r.id IS NULL THEN NULL ELSE
    jsonb_build_object('id',r.id,'status',r.status,'reason',r.reason,
      'amountMinor',r.amount_minor,'currency',r.currency,
      'requestedAt',to_char(r.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'completedAt',to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'progress',CASE
        WHEN r.status='SUCCEEDED' AND o.status='SUCCEEDED' THEN 'COMPLETED'
        WHEN o.id IS NULL OR o.status IN ('DEAD_LETTER','SUCCEEDED') OR r.status='SUCCEEDED'
          OR (o.status='PROCESSING' AND o.lease_expires_at<=now.at AND o.attempt_count>=o.max_attempts) THEN 'REVIEW_REQUIRED'
        WHEN o.status='RETRY_WAIT' OR (o.status='PROCESSING' AND o.lease_expires_at<=now.at) THEN 'RETRYING'
        WHEN o.status='PROCESSING' THEN 'PROCESSING'
        ELSE 'QUEUED' END) END AS refund
    FROM payment_attempts p LEFT JOIN refunds r ON r.payment_attempt_id=p.id
    LEFT JOIN outbox_events o ON o.kind='REFUND_CREATE' AND o.refund_id=r.id AND o.operation_key=r.request_key
    CROSS JOIN now WHERE p.id=$1 AND p.user_id=$2`, [paymentId, userId])).rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  return { ...row, paymentMode: 'simulated' };
}
