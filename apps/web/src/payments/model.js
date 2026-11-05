import { validId, instant } from '../discovery/model.js';

export const canonicalId = value => validId(value) && value === value.toLowerCase();
export function validPaymentCommand(command, userId, showId, reservationId) {
  return command && Object.keys(command).sort().join() === 'key,reservationId,showId,userId'
    && [userId, showId, reservationId].every(canonicalId)
    && command.userId === userId && command.showId === showId && command.reservationId === reservationId
    && typeof command.key === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(command.key);
}
export function validPayment(value, { showId, reservationId, agreement } = {}) {
  if (!value || !canonicalId(value.id) || value.showId !== showId || value.reservationId !== reservationId || value.paymentMode !== 'simulated'
    || !instant(value.createdAt) || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)
    || !['CREATED', 'PENDING', 'FAILED', 'SUCCEEDED'].includes(value.status)
    || (agreement && (value.amountMinor !== agreement.totalMinor || value.currency !== agreement.currency))) return false;
  return value.status === 'SUCCEEDED'
    ? (value.resolution === 'BOOKED' && canonicalId(value.bookingId)) || (value.resolution === 'REFUND_REQUIRED' && value.bookingId === null)
    : value.resolution === 'UNRESOLVED' && value.bookingId === null;
}
export function paymentOutcome(payment) {
  if (payment.resolution === 'BOOKED') return { title: 'Your seats are booked.', detail: 'The server confirmed this booking. Open your saved booking receipt to issue or recover admission tickets.', tone: 'booked' };
  if (payment.resolution === 'REFUND_REQUIRED') return { title: 'Refund requested.', detail: 'The simulated payment succeeded, but it could not fund a booking. Check the separate current refund record below for progress.', tone: 'review' };
  if (payment.status === 'FAILED') return { title: 'The simulated payment failed.', detail: 'This attempt will not be charged again here. A delayed success can still change its outcome; check its current status.', tone: 'review' };
  return { title: 'Your payment is processing.', detail: 'Keep this page or its address. Check status to recover the outcome. Starting payment does not extend your hold.', tone: 'pending' };
}
