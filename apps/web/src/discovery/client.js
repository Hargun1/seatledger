import { validId, instant, readSearch } from './model.js';

const messages = {
  NOT_FOUND: 'This programme or show is no longer available. It may have ended or been withdrawn.',
  INVALID_REQUEST: 'Check the search filters and date range, or clear them to start again.',
  INVENTORY_UNAVAILABLE: 'The saved seating plan is unavailable. Please check again later.',
  CATALOG_UNAVAILABLE: 'The programme is temporarily unavailable. Please try again.',
  CONNECTION_ERROR: 'We could not reach the programme. Check your connection and try again.',
  INVALID_RESPONSE: 'We could not confirm the programme response. Please try again.'
};
export class DiscoveryError extends Error {
  constructor(code, status = 0) {
    super(Object.hasOwn(messages, code) ? messages[code] : 'The programme could not be loaded. Please try again.');
    this.code = Object.hasOwn(messages, code) ? code : 'UNKNOWN'; this.status = status;
  }
}
const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const event = v => v && validId(v.id) && text(v.title, 200) && text(v.category, 60);
const venue = v => {
  if (!v || !validId(v.id) || !text(v.name, 160) || !text(v.city, 120) || !text(v.timezone, 80)) return false;
  try { new Intl.DateTimeFormat('en-IN', { timeZone: v.timezone }); return true; } catch { return false; }
};
const show = v => v && validId(v.id) && instant(v.startsAt) && venue(v.venue);
const page = (v, check, cursor) => v && Array.isArray(v.items) && v.items.length <= 20 && v.items.every(check) &&
  v.items.every((item, index) => item.id.toLowerCase() > (index ? v.items[index - 1].id.toLowerCase() : cursor?.toLowerCase() || '')) &&
  (v.nextCursor === null || (validId(v.nextCursor) && v.nextCursor === v.items.at(-1)?.id));
function cells(seats) {
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > 500) return false;
  const ids = new Set(), positions = new Set(), sections = new Map();
  for (const s of seats) {
    if (!s || !validId(s.id) || !validId(s.sectionId) || !text(s.section, 160) || !text(s.row, 32) ||
        !Number.isInteger(s.number) || s.number < 1 || s.number > 2147483647 || typeof s.state !== 'string' || !Object.hasOwn(stateLabels, s.state) ||
        !Number.isInteger(s.priceMinor) || s.priceMinor < 0 || s.priceMinor > 2147483647 || typeof s.currency !== 'string' || !/^[A-Z]{3}$/.test(s.currency)) return false;
    const position = JSON.stringify([s.sectionId, s.row, s.number]);
    if (ids.has(s.id) || positions.has(position) || (sections.has(s.sectionId) && sections.get(s.sectionId) !== s.section)) return false;
    ids.add(s.id); positions.add(position); sections.set(s.sectionId, s.section);
  }
  return true;
}
const stateLabels = { AVAILABLE: true, HELD: true, BOOKED: true };

export async function discoveryRequest(action, { eventId, showId, search = '', signal } = {}) {
  if (!['events', 'event', 'seats'].includes(action)) throw new DiscoveryError('INVALID_REQUEST', 400);
  if (action !== 'events' && (!validId(eventId) || (action === 'seats' && !validId(showId)))) throw new DiscoveryError('NOT_FOUND', 404);
  eventId = eventId?.toLowerCase(); showId = showId?.toLowerCase();
  const parsed = readSearch(search, action !== 'events');
  if (!parsed.valid || (action === 'seats' && search)) throw new DiscoveryError('INVALID_REQUEST', 400);
  const params = new URLSearchParams(search); if (action !== 'seats') params.set('limit', '20');
  const path = `/api/events${action === 'events' ? '' : `/${eventId}`}${action === 'seats' ? `/shows/${showId}/seats` : ''}` + (params.size ? '?' + params : '');
  let response;
  try { response = await fetch(path, { method: 'GET', credentials: 'omit', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
  catch (error) { if (signal?.aborted) throw error; throw new DiscoveryError('CONNECTION_ERROR'); }
  let data; try { data = await response.json(); } catch { throw new DiscoveryError('INVALID_RESPONSE'); }
  if (!response.ok) throw new DiscoveryError(data?.error, response.status);
  let valid = data?.paymentMode === 'simulated';
  if (action === 'events') valid = valid && page(data, v => event(v) && show(v.nextShow), parsed.cursor);
  else if (action === 'event') valid = valid && event(data.event) && data.event.id === eventId && page(data.shows, show, parsed.cursor);
  else valid = valid && event(data.event) && data.event.id === eventId && show(data.show) && data.show.id === showId &&
    data.advisory === true && data.readOnly === true && instant(data.asOf) && cells(data.seats);
  if (response.status !== 200 || !valid) throw new DiscoveryError('INVALID_RESPONSE');
  return data;
}
