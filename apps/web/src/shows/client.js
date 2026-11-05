import { WorkspaceError, validId } from '../organizers/client.js';

export class ShowError extends WorkspaceError {
  constructor(code, status = 0) {
    super(code, status);
    const messages = {
      SHOW_STALE: 'Someone changed this show. Reload before editing again.',
      VENUE_STALE: 'The venue plan changed. Reload and choose it again.',
      SHOW_IN_USE: 'This show already has inventory or agreements. Draft changes are closed.',
      SHOW_NOT_EDITABLE: 'This show is no longer open for draft changes.',
      SHOW_TIME_PASSED: 'The show start must be in the future. Check its saved time.',
      SHOW_PRICE_REQUIRED: 'An explicit INR price is needed before this show can be changed.',
      VENUE_LAYOUT_REQUIRED: 'This venue needs a populated seating plan first.',
      LAYOUT_TOO_LARGE: 'This venue plan exceeds the supported size.',
      EVENT_SHOW_LIMIT: 'This event already has the maximum of 20 shows.',
      OWNER_REQUIRED: 'Only an active owner can change shows.'
    };
    if (Object.hasOwn(messages, this.code)) this.message = messages[this.code];
  }
}
export async function settleInScope(work, isCurrent) {
  const result = await work();
  if (!isCurrent()) throw new ShowError('INVALID_RESPONSE');
  return result;
}
const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const revision = n => Number.isInteger(n) && n >= 0 && n <= 2147483647;
const timestamp = s => typeof s === 'string' && /Z$/.test(s) && Number.isFinite(Date.parse(s));
const event = (v, id) => v && v.id === id && text(v.title, 200) && text(v.category, 60) && ['DRAFT', 'PUBLISHED', 'CANCELLED'].includes(v.status);
const access = (v, id) => v && v.id === id && text(v.name, 160) && v.status === 'APPROVED' && ['OWNER', 'STAFF'].includes(v.role);
const show = (v, eventId) => v && validId(v.id) && v.eventId === eventId && validId(v.venueId) && timestamp(v.startsAt)
  && ['SCHEDULED', 'CANCELLED', 'COMPLETED'].includes(v.status) && revision(v.revision)
  && ((v.priceMinor === null && v.currency === null) || (Number.isInteger(v.priceMinor) && v.priceMinor >= 0 && v.priceMinor <= 100000000 && /^[A-Z]{3}$/.test(v.currency)));
export async function showRequest(action, { organizationId, eventId, showId, venueId, cursor, body, csrfToken, signal } = {}) {
  const methods = { list: 'GET', detail: 'GET', create: 'POST', patch: 'PATCH', delete: 'DELETE' };
  if (!Object.hasOwn(methods, action)) throw new ShowError('INVALID_REQUEST', 400);
  if (!validId(organizationId) || !validId(eventId) || (!['list', 'create'].includes(action) && !validId(showId)) || (cursor && !validId(cursor))) throw new ShowError('NOT_FOUND', 404);
  const method = methods[action]; let path = `/api/organizers/${organizationId}/events/${eventId}/shows${['list', 'create'].includes(action) ? '' : `/${showId}`}`;
  if (action === 'list') path += `?limit=20${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  let response;
  try { response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) } : {}) }); }
  catch (error) { if (signal?.aborted) throw error; throw new ShowError('CONNECTION_ERROR'); }
  let data; try { data = await response.json(); } catch { throw new ShowError('INVALID_RESPONSE'); }
  if (!response.ok) throw new ShowError(data?.error, response.status);
  let valid;
  if (action === 'list') valid = data && event(data.event, eventId) && access(data.organization, organizationId) && Array.isArray(data.items) && data.items.length <= 20
    && data.items.every(v => show(v, eventId)) && new Set(data.items.map(v => v.id)).size === data.items.length
    && (data.nextCursor === null || (validId(data.nextCursor) && data.nextCursor === data.items.at(-1)?.id));
  else if (action === 'delete') valid = data?.id === showId && data.deleted === true;
  else {
    valid = show(data, eventId) && (action === 'create' ? data.revision === 0 && data.venueId === body?.venueId && data.currency === 'INR' : data.id === showId);
    if (action === 'detail') valid = valid && event(data.event, eventId) && access(data.organization, organizationId) && typeof data.inUse === 'boolean';
    else valid = valid && data.status === 'SCHEDULED' && (body?.priceMinor === undefined || data.priceMinor === body.priceMinor)
      && (body?.startsAt === undefined || Date.parse(data.startsAt) === Date.parse(body.startsAt));
    if (action === 'patch') valid = valid && data.venueId === venueId && data.currency === 'INR' && (data.revision === body?.expectedRevision || data.revision === body?.expectedRevision + 1);
  }
  if (response.status !== (action === 'create' ? 201 : 200) || !valid) throw new ShowError('INVALID_RESPONSE');
  return data;
}
