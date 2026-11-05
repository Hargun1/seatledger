import { validAgreement } from '../reservations/model.js';
import { canonicalId, validPayment, validPaymentCommand } from './model.js';

const messages = {
  AUTH_REQUIRED: 'Please check your session before continuing.', CSRF_REJECTED: 'Your session changed. Check your session, then recover this request.',
  ORIGIN_REJECTED: 'This request could not be accepted from this address.', INVALID_REQUEST: 'The checkout request could not be accepted.',
  NOT_FOUND: 'This hold or payment is unavailable for your account.', RESERVATION_NOT_PAYABLE: 'This hold can no longer start a payment. Check its current outcome.',
  PAYMENT_REVIEW_REQUIRED: 'This payment needs review. Check existing attempts before continuing.', IDEMPOTENCY_CONFLICT: 'Keep the original request reference for recovery.',
  ACCESS_BUSY: 'The server is busy. Retry this same request shortly.', CONNECTION_ERROR: 'We could not confirm a response. Check your connection.',
  INVALID_RESPONSE: 'We could not verify the checkout response.', STORAGE_UNAVAILABLE: 'This tab could not keep its recovery reference. New payment requests are paused.',
  UNKNOWN: 'The checkout request could not be confirmed. Check its current status.'
};
export class CheckoutError extends Error {
  constructor(code, status = 0, uncertain = false) { super(Object.hasOwn(messages, code) ? messages[code] : messages.UNKNOWN); this.code = Object.hasOwn(messages, code) ? code : 'UNKNOWN'; this.status = status; this.uncertain = uncertain; }
}
const definite = { INVALID_REQUEST: 400, NOT_FOUND: 404, RESERVATION_NOT_PAYABLE: 409, PAYMENT_REVIEW_REQUIRED: 409 };
export async function checkoutRequest(action, { userId, showId, reservationId, paymentId, command, csrfToken, agreement, after, signal, fetchImpl = globalThis.fetch } = {}) {
  const write = ['start', 'resolve'].includes(action);
  if (!['agreement', 'history', 'read', 'start', 'resolve'].includes(action) || ![userId, showId, reservationId].every(canonicalId)
    || (action === 'read' && !canonicalId(paymentId)) || (after !== undefined && !canonicalId(after))
    || (write && !validPaymentCommand(command, userId, showId, reservationId))) throw new CheckoutError('INVALID_REQUEST', 400);
  if (write && (typeof csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken))) throw new CheckoutError('AUTH_REQUIRED', 401, true);
  let path = action === 'read' ? `/api/payments/${paymentId}` : `/api/reservations/${reservationId}`;
  if (action === 'history' || action === 'start') path += '/payment-attempts';
  if (action === 'resolve') path += '/resolve-payment';
  if (action === 'history' && after) path += '?after=' + after;
  let response, data;
  try {
    response = await fetchImpl(path, { method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      ...(write ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken, 'Idempotency-Key': command.key }, body: '{}' } : {}) });
    data = await response.json();
  } catch { throw new CheckoutError(response ? 'INVALID_RESPONSE' : 'CONNECTION_ERROR', 0, write); }
  if (!response.ok) {
    if (write && response.status === 409 && data?.error === 'REQUEST_CLOSED') {
      if (data.operation === 'payment.create' && data.requestKey === command.key && data.paymentMode === 'simulated') return data;
      throw new CheckoutError('INVALID_RESPONSE', 0, true);
    }
    throw new CheckoutError(data?.error, response.status, write && definite[data?.error] !== response.status);
  }
  const scope = { showId, reservationId, agreement };
  const invalid = () => { throw new CheckoutError('INVALID_RESPONSE', 0, write); };
  if (action === 'agreement') {
    if (response.status !== 200 || data?.id !== reservationId || !validAgreement(data, showId)) invalid();
  } else if (action === 'history') {
    if (response.status !== 200 || data?.reservationId !== reservationId || data.paymentMode !== 'simulated' || !Array.isArray(data.items)
      || data.items.length > 20 || !data.items.every((p, i) => validPayment(p, scope) && p.id > (data.items[i - 1]?.id || after || ''))
      || !(data.nextCursor === null || (data.items.length === 20 && data.nextCursor === data.items.at(-1)?.id))) invalid();
  } else if (!(write ? [200, 201].includes(response.status) : response.status === 200) || !validPayment(data, scope)
    || (action === 'read' && data.id !== paymentId)) invalid();
  return data;
}
export async function readPaymentHistory(options) {
  const items = []; let after;
  for (let page = 0; page < 25; page++) {
    const result = await checkoutRequest('history', { ...options, after }); items.push(...result.items);
    if (!result.nextCursor) return items; after = result.nextCursor;
  }
  throw new CheckoutError('INVALID_RESPONSE');
}
