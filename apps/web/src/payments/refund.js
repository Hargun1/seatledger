import { canonicalId } from './model.js';
import { instant } from '../discovery/model.js';
import { CheckoutError } from './client.js';

const exactInstant = value => instant(value) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value);

export function validRefundStatus(value, payment) {
  if (!value || value.paymentId !== payment.id || value.paymentMode !== 'simulated') return false;
  if (value.refund === null) return true;
  const r = value.refund;
  return !!r && canonicalId(r.id) && r.amountMinor === payment.amountMinor && r.currency === payment.currency
    && Number.isSafeInteger(r.amountMinor) && r.amountMinor >= 0
    && ['HOLD_EXPIRED','INVENTORY_LOST','DUPLICATE_PAYMENT','CUSTOMER_CANCELLED','EVENT_CANCELLED'].includes(r.reason)
    && ['REQUESTED','PROCESSING','RETRYABLE_FAILURE','SUCCEEDED'].includes(r.status)
    && ['QUEUED','PROCESSING','RETRYING','COMPLETED','REVIEW_REQUIRED'].includes(r.progress)
    && exactInstant(r.requestedAt)
    && (r.status === 'SUCCEEDED' ? exactInstant(r.completedAt) && r.completedAt >= r.requestedAt : r.completedAt === null)
    && (r.progress !== 'COMPLETED' || r.status === 'SUCCEEDED')
    && (r.status !== 'SUCCEEDED' || ['COMPLETED','REVIEW_REQUIRED'].includes(r.progress));
}

export async function readCustomerRefund({ payment, signal, fetchImpl = globalThis.fetch }) {
  if (!canonicalId(payment?.id)) throw new CheckoutError('INVALID_REQUEST', 400);
  let response, data;
  try {
    response = await fetchImpl(`/api/payments/${payment.id}/refund`, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
    data = await response.json();
  } catch { throw new CheckoutError(response ? 'INVALID_RESPONSE' : 'CONNECTION_ERROR'); }
  if (!response.ok) throw new CheckoutError(data?.error, response.status);
  if (response.status !== 200 || !validRefundStatus(data, payment)) throw new CheckoutError('INVALID_RESPONSE');
  return data;
}

export function refundOutcome(value) {
  switch (value?.refund?.progress) {
    case 'COMPLETED': return { title: 'Simulated refund completed.', detail: 'The server recorded the full simulated refund. No real money was moved.' };
    case 'QUEUED': return { title: 'Refund queued.', detail: 'Your full simulated refund is saved and waiting for processing.' };
    case 'PROCESSING': return { title: 'Refund processing.', detail: 'Processing has started. Completion is not yet confirmed.' };
    case 'RETRYING': return { title: 'Refund will be retried.', detail: 'Completion is not confirmed. The same refund request can be recovered by the worker.' };
    case 'REVIEW_REQUIRED': return { title: 'Refund needs review.', detail: 'Automatic processing cannot confirm a consistent completion. Keep your payment reference; a status check does not restart processing.' };
    default: return { title: 'Refund status unavailable.', detail: 'No saved refund record was returned. This does not confirm completion. Keep your payment reference and check again.' };
  }
}
