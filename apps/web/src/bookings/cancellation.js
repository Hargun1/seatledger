import { canonicalId } from '../payments/model.js';
import { instant } from '../discovery/model.js';

export function validCancellationPolicy(v) {
  return v?.version==='customer-cancel-v1' && Number.isInteger(v.cutoffMinutes) && v.cutoffMinutes>=0 && v.cutoffMinutes<=10080
    && v.refund==='FULL' && v.paymentMode==='simulated';
}
export function validCancellation(v,id) {
  return v?.bookingId===id && canonicalId(id) && v.paymentMode==='simulated' && validCancellationPolicy(v.policy)
    && ['CONFIRMED','CANCELLED'].includes(v.status) && instant(v.deadline)
    && (v.paymentId===null || canonicalId(v.paymentId)) && (v.refundId===null || canonicalId(v.refundId))
    && (v.status==='CANCELLED' ? instant(v.cancelledAt) && v.reason==='ALREADY_CANCELLED' && v.eligible===false
      : v.cancelledAt===null && ['ELIGIBLE','UNAVAILABLE','CUTOFF_PASSED','ALREADY_USED','REVIEW_REQUIRED'].includes(v.reason) && v.eligible===(v.reason==='ELIGIBLE'))
    && (!v.eligible || (canonicalId(v.paymentId) && v.refundId===null));
}
export class CancellationError extends Error {
  constructor(status=0,uncertain=false) {
    super(status===401 || status===403 ? 'Check your session before continuing.' : status===404 ? 'This booking is unavailable for your account.'
      : status===409 ? 'Cancellation cannot be accepted now. Refresh the current booking status.' : 'We could not confirm cancellation status. Check it again.');
    this.status=status; this.uncertain=uncertain;
  }
}
async function request(path,{cancel=false,csrfToken,signal,fetchImpl=globalThis.fetch}={}) {
  if(cancel && (typeof csrfToken!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken))) throw new CancellationError(401);
  let response,data;
  try {
    response=await fetchImpl(path,{method:cancel?'POST':'GET',credentials:'same-origin',cache:'no-store',
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000),
      ...(cancel?{headers:{'Content-Type':'application/json','X-SeatLedger-Client':'web','X-CSRF-Token':csrfToken},body:'{}'}:{})});
    data=await response.json();
  }catch{throw new CancellationError(0,cancel);}
  if(!response.ok || response.status!==200)throw new CancellationError(response.status,cancel);
  return data;
}
export async function readBookingPolicy(options) {
  const value=await request('/api/booking-policy',options);
  if(!validCancellationPolicy(value))throw new CancellationError();return value;
}
export async function cancellationRequest({bookingId,...options}) {
  if(!canonicalId(bookingId))throw new CancellationError(400);
  const value=await request(`/api/bookings/${bookingId}/cancellation`,options);
  if(!validCancellation(value,bookingId) || (options.cancel && value.status!=='CANCELLED'))throw new CancellationError(0,Boolean(options.cancel));
  return value;
}
