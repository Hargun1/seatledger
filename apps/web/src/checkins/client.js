import { canonicalId } from '../payments/model.js';
import { instant } from '../discovery/model.js';

const messages = {
  INVALID_REQUEST: 'Paste a complete SeatLedger admission credential.',
  AUTH_REQUIRED: 'Your session ended. Sign in again to recover this request.',
  CSRF_REJECTED: 'Your session changed. Reload before continuing.',
  ORIGIN_REJECTED: 'Use the configured SeatLedger address.',
  NOT_FOUND: 'No matching ticket or receipt is available in this show.',
  ORGANIZER_NOT_APPROVED: 'This organization cannot check in tickets right now.',
  TICKET_UNAVAILABLE: 'This ticket cannot be admitted in its current state.',
  TICKET_ALREADY_USED: 'This ticket has already been checked in. Do not admit again.',
  CHECKIN_REQUEST_CONFLICT: 'This request identity belongs to a different recorded operation.',
  ACCESS_BUSY: 'The entrance register is busy. Recover the original request before retrying.',
  STORAGE_UNAVAILABLE: 'Recovery storage is unavailable. No new scan can be started safely.',
  WRONG_TICKET: 'This unresolved request belongs to another ticket. Paste that original ticket to retry.',
  UNKNOWN: 'The result could not be confirmed. Keep this request and check its recorded outcome.'
};
export class CheckinError extends Error {
  constructor(code = 'UNKNOWN', status = 0) {
    const safe = Object.hasOwn(messages, code) ? code : 'UNKNOWN';
    super(messages[safe]); this.code = safe; this.status = status;
    this.definite = [400, 401, 403, 404, 409, 415].includes(status) && safe !== 'UNKNOWN';
  }
}
export function credentialId(value) {
  if (typeof value !== 'string' || value.length !== 84 || !/^sl1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const id = value.split('.')[1]; return canonicalId(id) ? id : null;
}
export function validScanCommand(value, scope) {
  return value && Object.keys(value).sort().join() === 'organizationId,requestKey,showId,ticketId,userId'
    && Object.values(value).every(canonicalId)
    && value.userId === scope.userId && value.organizationId === scope.organizationId && value.showId === scope.showId;
}
export function createScanJournal(scope, storage = () => globalThis.sessionStorage) {
  const name = `seatledger:checkin:v1:${scope.userId}:${scope.organizationId}:${scope.showId}`;
  function read() {
    try {
      const raw = storage().getItem(name); if (raw === null) return null;
      if (raw.length > 600) throw new Error(); const value = JSON.parse(raw);
      if (!validScanCommand(value, scope)) throw new Error(); return value;
    } catch { throw new CheckinError('STORAGE_UNAVAILABLE'); }
  }
  return { read,
    save(value) {
      try {
        if (!validScanCommand(value, scope)) throw new Error(); storage().setItem(name, JSON.stringify(value));
        if (JSON.stringify(read()) !== JSON.stringify(value)) throw new Error();
      } catch { throw new CheckinError('STORAGE_UNAVAILABLE'); }
    },
    clear() { try { storage().removeItem(name); if (storage().getItem(name) !== null) throw new Error(); }
      catch { throw new CheckinError('STORAGE_UNAVAILABLE'); } }
  };
}
function validReceipt(data, command, status, recover) {
  const c = data?.checkin, fresh = status === 201 && !recover;
  return data?.paymentMode === 'simulated' && data.status === (fresh ? 'CHECKED_IN' : 'ALREADY_RECORDED')
    && data.admissionGranted === fresh && c?.ticketId === command.ticketId && c?.showId === command.showId
    && c?.requestKey === command.requestKey && canonicalId(c?.bookingItemId) && instant(c?.checkedAt)
    && typeof c.section === 'string' && c.section.length >= 1 && c.section.length <= 160
    && typeof c.row === 'string' && c.row.length >= 1 && c.row.length <= 32 && Number.isInteger(c.number) && c.number > 0
    && Object.keys(data).sort().join() === 'admissionGranted,checkin,paymentMode,status'
    && Object.keys(c).sort().join() === 'bookingItemId,checkedAt,number,requestKey,row,section,showId,ticketId';
}
export async function checkinRequest({ command, credential, csrfToken, recover = false, signal, fetchImpl = globalThis.fetch }) {
  if (!validScanCommand(command, command)) throw new CheckinError('INVALID_REQUEST');
  if (!recover && (credentialId(credential) !== command.ticketId || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken || ''))) throw new CheckinError('INVALID_REQUEST');
  const path = `/api/organizers/${command.organizationId}/shows/${command.showId}/check-ins` + (recover ? '/' + command.requestKey : '');
  let response, data;
  try {
    response = await fetchImpl(path, { method: recover ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      ...(!recover ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ credential, requestKey: command.requestKey }) } : {}) });
    data = await response.json();
  } catch { throw new CheckinError(); }
  if (!response.ok) throw new CheckinError(data?.error, response.status);
  if (!(recover ? response.status === 200 : [200, 201].includes(response.status)) || !validReceipt(data, command, response.status, recover)) throw new CheckinError();
  return data;
}
