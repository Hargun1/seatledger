import { validId, instant } from '../discovery/model.js';
import { validAgreement, validCommand } from './model.js';

const messages = {
  AUTH_REQUIRED: 'Please check your session before continuing.', CSRF_REJECTED: 'Your session changed. Check your session and retry this request.',
  ORIGIN_REJECTED: 'This request could not be accepted from this address.',
  SEATS_UNAVAILABLE: 'Some chosen seats are no longer available. Check the current availability.',
  SHOW_STARTED: 'This performance has already started.', NOT_FOUND: 'This show or agreement is no longer available for this action.',
  INVALID_REQUEST: 'The reservation request could not be accepted.', MIXED_CURRENCY: 'Choose seats priced in the same currency.',
  RESERVATION_CLOSED: 'This agreement cannot be released here.', ACCESS_BUSY: 'The server is busy. Retry the same request shortly.',
  IDEMPOTENCY_CONFLICT: 'This request reference does not match the saved request. Keep it for recovery.',
  CONNECTION_ERROR: 'We could not confirm a response. Check your connection.', INVALID_RESPONSE: 'We could not verify the response.',
  STORAGE_UNAVAILABLE: 'This tab could not save or clear its recovery reference. New requests are paused.',
  UNKNOWN: 'The request could not be confirmed. Please try again.'
};
export class BookingError extends Error {
  constructor(code, status = 0, { uncertain = false, unavailableSeatIds = [] } = {}) {
    super(Object.hasOwn(messages, code) ? messages[code] : messages.UNKNOWN);
    this.code = Object.hasOwn(messages, code) ? code : 'UNKNOWN'; this.status = status;
    this.uncertain = uncertain; this.unavailableSeatIds = unavailableSeatIds;
  }
}
const rejected = { INVALID_REQUEST: 400, NOT_FOUND: 404, SEATS_UNAVAILABLE: 409, SHOW_STARTED: 409, MIXED_CURRENCY: 409, RESERVATION_CLOSED: 409 };
export async function reservationRequest(action, { userId, showId, command, csrfToken, after, signal, fetchImpl = globalThis.fetch } = {}) {
  if (!['current', 'create', 'release', 'resolve'].includes(action) || !validId(showId) || !validId(userId)) throw new BookingError('INVALID_REQUEST', 400);
  const write = action !== 'current';
  const kind = action === 'resolve' ? command?.kind : action;
  if (write && (!validCommand(command, userId, showId) || command.kind !== kind)) throw new BookingError('INVALID_REQUEST', 400);
  if (write && (typeof csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken))) throw new BookingError('AUTH_REQUIRED', 401, { uncertain: true });
  if (after !== undefined && !validId(after)) throw new BookingError('INVALID_REQUEST', 400);
  const params = new URLSearchParams({ showId }); if (after) params.set('after', after);
  const path = write ? `/api/reservations${action === 'resolve' ? (kind === 'create' ? '/resolve-create' : `/${command.reservationId}/resolve-release`)
    : kind === 'release' ? `/${command.reservationId}/release` : ''}` : '/api/reservations/current?' + params;
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
  let response, data;
  try {
    response = await fetchImpl(path, { method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: combined,
      ...(write ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken, 'Idempotency-Key': command.key },
        body: JSON.stringify(kind === 'create' ? { showId, seatIds: command.seatIds } : {}) } : {}) });
    data = await response.json();
  } catch { throw new BookingError(response ? 'INVALID_RESPONSE' : 'CONNECTION_ERROR', 0, { uncertain: write }); }
  if (!response.ok) {
    if (write && response.status === 409 && data?.error === 'REQUEST_CLOSED') {
      if (data.paymentMode === 'simulated' && data.operation === `reservation.${kind}` && data.requestKey === command.key) return data;
      throw new BookingError('INVALID_RESPONSE', 0, { uncertain: true });
    }
    const seats = data?.unavailableSeatIds;
    const validConflicts = Array.isArray(seats) && seats.length >= 1 && seats.length <= 8 && new Set(seats).size === seats.length
      && seats.every(id => validId(id) && command?.seatIds?.includes(id));
    const definite = rejected[data?.error] === response.status && (data.error !== 'SEATS_UNAVAILABLE' || validConflicts);
    throw new BookingError(data?.error, response.status, { uncertain: write && !definite, unavailableSeatIds: validConflicts ? seats : [] });
  }
  if (!write) {
    const rows = data?.reservations;
    if (response.status !== 200 || !data || data.showId !== showId || data.readOnly !== true || data.paymentMode !== 'simulated' || !instant(data.asOf)
      || !Array.isArray(rows) || rows.length > 20 || !rows.every((r, i) => validAgreement(r, showId) && r.status === 'ACTIVE' && r.effectiveStatus === 'ACTIVE'
        && r.id > (rows[i - 1]?.id || after || ''))
      || !(data.nextCursor === null || (rows.length === 20 && data.nextCursor === rows.at(-1)?.id))) throw new BookingError('INVALID_RESPONSE');
    return data;
  }
  if (response.status !== (kind === 'create' ? 201 : 200) || !validAgreement(data, showId)
    || (kind === 'release' ? data.id !== command.reservationId || !['RELEASED', 'EXPIRED'].includes(data.status) : data.items.map(s => s.id).join() !== command.seatIds.join()))
    throw new BookingError('INVALID_RESPONSE', 0, { uncertain: true });
  return data; // A saved create replay may be historical; always read current state.
}
export async function readAllCurrent(options) {
  const rows = []; let after, asOf;
  for (let page = 0; page < 25; page++) {
    const result = await reservationRequest('current', { ...options, after });
    asOf ??= result.asOf; rows.push(...result.reservations);
    if (!result.nextCursor) return { reservations: rows, asOf };
    after = result.nextCursor;
  }
  throw new BookingError('INVALID_RESPONSE'); // Refuse partial recovery beyond a 500-seat map.
}
