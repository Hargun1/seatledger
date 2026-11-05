import { canonicalId, validPayment } from './model.js';
import { instant } from '../discovery/model.js';
import { CheckoutError } from './client.js';

const cursorOk = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const exactInstant = value => instant(value) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length>0 && value.length<=max;
export function validPaymentHistoryItem(value) {
  if (!value || ![value.showId,value.reservationId].every(canonicalId)
    || !validPayment(value, { showId: value.showId, reservationId: value.reservationId }) || !exactInstant(value.createdAt)) return false;
  const p = value.currentProgramme;
  if (!p || !canonicalId(p.eventId) || p.current!==true || !text(p.title,200) || !text(p.venue,160)
    || !text(p.city,120) || !instant(p.startsAt) || !text(p.timezone,80)) return false;
  try { new Intl.DateTimeFormat('en-IN', { timeZone: p.timezone }); } catch { return false; }
  return true;
}

export function paymentHistoryCheckoutPath(value) {
  if (!validPaymentHistoryItem(value)) return null;
  return `/events/${value.currentProgramme.eventId}/shows/${value.showId}/checkout/${value.reservationId}`;
}

export async function readAccountPayments({ cursor, signal, fetchImpl = globalThis.fetch } = {}) {
  if (cursor!==undefined && !cursorOk(cursor)) throw new CheckoutError('INVALID_REQUEST',400);
  let response, data;
  try {
    response = await fetchImpl('/api/payments'+(cursor?'?cursor='+cursor:''), { method: 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
    data = await response.json();
  } catch { throw new CheckoutError(response ? 'INVALID_RESPONSE' : 'CONNECTION_ERROR'); }
  if (!response.ok) throw new CheckoutError(data?.error,response.status);
  if (response.status!==200 || data?.paymentMode!=='simulated' || !Array.isArray(data.items) || data.items.length>20
    || !data.items.every((v,i) => validPaymentHistoryItem(v) && (!i || v.createdAt<data.items[i-1].createdAt
      || (v.createdAt===data.items[i-1].createdAt && v.id>data.items[i-1].id)))
    || new Set(data.items.map(v=>v.id)).size!==data.items.length
    || !(data.nextCursor===null || (data.items.length===20 && cursorOk(data.nextCursor) && data.nextCursor!==cursor)))
    throw new CheckoutError('INVALID_RESPONSE');
  return data;
}
