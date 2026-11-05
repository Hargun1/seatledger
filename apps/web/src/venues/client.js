import { WorkspaceError, validId } from '../organizers/client.js';
import { validZone } from './model.js';

export class VenueError extends WorkspaceError {
  constructor(code, status = 0) {
    super(code, status);
    const messages = {
      VENUE_STALE: 'Someone changed this venue. Reload it before making another change.',
      VENUE_IN_USE: 'A show now uses this venue. Its details and seating plan are locked.',
      LAYOUT_TOO_LARGE: 'This saved layout is too large for this editor.',
      OWNER_REQUIRED: 'Only an active owner can change venues.'
    };
    if (Object.hasOwn(messages, this.code)) this.message = messages[this.code];
  }
}
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const revision = v => Number.isInteger(v) && v >= 0 && v <= 2147483647;
const venue = v => v && validId(v.id) && text(v.name, 160) && text(v.city, 120) && validZone(v.timezone) && revision(v.revision);
const access = (v, id) => v && v.id === id && text(v.name, 160) && v.status === 'APPROVED' && ['OWNER', 'STAFF'].includes(v.role);
function layout(value) {
  if (!Array.isArray(value) || value.length > 20) return false;
  const ids = new Set(), sectionNames = new Set(); let count = 0;
  for (const section of value) {
    if (!validId(section.id) || ids.has(section.id) || !text(section.name, 80) || sectionNames.has(section.name) || !Array.isArray(section.seats)) return false;
    ids.add(section.id); sectionNames.add(section.name); const labels = new Set();
    for (const seat of section.seats) {
      if (!validId(seat.id) || ids.has(seat.id) || !text(seat.rowLabel, 8) || !Number.isInteger(seat.number) || seat.number < 1 || seat.number > 2147483647) return false;
      const key = JSON.stringify([seat.rowLabel, seat.number]); if (labels.has(key)) return false;
      ids.add(seat.id); labels.add(key); if (++count > 500) return false;
    }
  }
  return true;
}
export async function venueRequest(action, { organizationId, venueId, cursor, body, csrfToken, signal } = {}) {
  if (!validId(organizationId) || (!['list', 'create'].includes(action) && !validId(venueId)) || (cursor && !validId(cursor))) throw new VenueError('NOT_FOUND', 404);
  const methods = { list: 'GET', detail: 'GET', create: 'POST', patch: 'PATCH', layout: 'PUT', delete: 'DELETE' };
  const method = Object.hasOwn(methods, action) ? methods[action] : undefined;
  if (!method) throw new VenueError('INVALID_REQUEST', 400);
  let path = `/api/organizers/${organizationId}/venues${['list', 'create'].includes(action) ? '' : `/${venueId}`}${action === 'layout' ? '/layout' : ''}`;
  if (action === 'list') path += `?limit=20${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  let response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) } : {}) });
  } catch (error) { if (signal?.aborted) throw error; throw new VenueError('CONNECTION_ERROR'); }
  let data;
  try { data = await response.json(); } catch { throw new VenueError('INVALID_RESPONSE'); }
  if (!response.ok) throw new VenueError(data?.error, response.status);
  let valid;
  if (action === 'list') valid = data && access(data.organization, organizationId) && Array.isArray(data.items) && data.items.length <= 20 && data.items.every(venue)
    && new Set(data.items.map(item => item.id)).size === data.items.length
    && (data.nextCursor === null || (validId(data.nextCursor) && data.nextCursor === data.items.at(-1)?.id));
  else if (action === 'delete') valid = data?.id === venueId && data.deleted === true;
  else {
    valid = venue(data) && (action === 'create' ? data.revision === 0 : data.id === venueId);
    if (action === 'detail') valid = valid && access(data.organization, organizationId) && typeof data.hasShows === 'boolean' && layout(data.sections);
    if (action === 'layout') valid = valid && data.revision === body.expectedRevision + 1 && data.hasShows === false && layout(data.sections)
      && data.sections.length > 0 && data.sections.every(section => section.seats.length > 0);
    if (action === 'patch') valid = valid && [body.expectedRevision, body.expectedRevision + 1].includes(data.revision);
  }
  if (response.status !== (action === 'create' ? 201 : 200) || !valid) throw new VenueError('INVALID_RESPONSE');
  return data;
}
