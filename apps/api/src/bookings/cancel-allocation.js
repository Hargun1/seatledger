// Caller owns a transaction and the catalogue -> whole stock -> reservation ->
// booking -> funding payment locks, and has rechecked the chosen policy.
export async function cancelAllocation(db,{bookingId,showId,reservationId,seatIds,paymentId,reason,userId=null,metadata={}}) {
  if(!['CUSTOMER_CANCELLED','EVENT_CANCELLED'].includes(reason)||seatIds.length<1||seatIds.length>8)throw new TypeError('Invalid cancellation intent');
  const changed=await db.query("UPDATE bookings SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=$1 AND status='CONFIRMED'",[bookingId]);
  if(changed.rowCount!==1)throw new Error('Cancellation was not recorded');
  const released=await db.query(`UPDATE show_seats SET state='AVAILABLE',reservation_id=NULL,booking_id=NULL,expires_at=NULL
    WHERE show_id=$1 AND booking_id=$2 AND reservation_id=$3 AND state='BOOKED' AND venue_seat_id=ANY($4::uuid[])`,[showId,bookingId,reservationId,seatIds]);
  if(released.rowCount!==seatIds.length)throw new Error('Incomplete cancelled allocation');
  const refund=(await db.query(`INSERT INTO refunds(payment_attempt_id,amount_minor,currency,reason)
    SELECT id,amount_minor,currency,$3 FROM payment_attempts WHERE id=$1 AND booking_id=$2 AND status='SUCCEEDED' AND resolution='BOOKED'
    RETURNING id,request_key`,[paymentId,bookingId,reason])).rows[0];
  if(!refund)throw new Error('Cancellation refund was not requested');
  await db.query("INSERT INTO outbox_events(kind,refund_id,operation_key) VALUES('REFUND_CREATE',$1,$2)",[refund.id,refund.request_key]);
  await db.query(`INSERT INTO audit_events(operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,$3,'booking.cancelled','booking',$4,$5)`,[refund.request_key,userId?'USER':'WORKER',userId,bookingId,
    {...metadata,reason,refundId:refund.id,paymentAttemptId:paymentId}]);
  return refund.id;
}
