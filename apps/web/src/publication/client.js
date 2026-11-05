import { WorkspaceError, validId } from '../organizers/client.js';
import { validZone } from '../venues/model.js';

export class PublicationError extends WorkspaceError {
  constructor(code, status = 0) {
    super(code, status);
    const messages = {
      PUBLICATION_STALE: 'The programme changed after review. Check its status and prepare a new review.',
      EVENT_SHOWS_REQUIRED: 'Add at least one show before reviewing publication.',
      PUBLICATION_TOO_LARGE: 'This programme exceeds the publication limit of 20 shows and 10,000 seats.',
      SHOW_TIME_PASSED: 'Every show must start in the future. Update the schedule before reviewing again.',
      SHOW_PRICE_REQUIRED: 'Every show needs an explicit INR price before publication.',
      SHOW_NOT_EDITABLE: 'Every show must be scheduled before this draft can be published.',
      SHOW_IN_USE: 'Inventory or agreements already exist. Publication will not overwrite them.',
      VENUE_LAYOUT_REQUIRED: 'A venue needs a populated seating plan before publication.',
      LAYOUT_TOO_LARGE: 'A venue exceeds the supported layout size.',
      OWNER_REQUIRED: 'Only an active owner can confirm publication.'
    };
    if (Object.hasOwn(messages, this.code)) this.message = messages[this.code];
  }
}
const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const revision = n => Number.isInteger(n) && n >= 0 && n <= 2147483647;
function time(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s))) return false;
  const [y, m, d, h, minute, sec] = s.slice(0, 19).match(/\d+/g).map(Number), date = new Date(0);
  date.setUTCFullYear(y, m - 1, d); date.setUTCHours(h, minute, sec, 0);
  return y > 0 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && date.getUTCHours() === h && date.getUTCMinutes() === minute && date.getUTCSeconds() === sec;
}
const event = (v, id) => v && v.id === id && text(v.title, 200) && text(v.category, 60) && revision(v.publicationRevision);
const access = (v, id) => v && v.id === id && text(v.name, 160) && v.status === 'APPROVED' && ['OWNER', 'STAFF'].includes(v.role);
const show = v => v && validId(v.id) && validId(v.venueId) && v.status === 'SCHEDULED' && revision(v.revision) && time(v.startsAt)
  && Number.isInteger(v.priceMinor) && v.priceMinor >= 0 && v.priceMinor <= 100000000 && v.currency === 'INR' && Number.isInteger(v.seatCount) && v.seatCount >= 1 && v.seatCount <= 500;
function rows(value) {
  return Array.isArray(value?.shows) && value.shows.length >= 1 && value.shows.length <= 20 && value.shows.every(show)
    && new Set(value.shows.map(s => s.id)).size === value.shows.length && Number.isInteger(value.inventoryCount)
    && value.inventoryCount <= 10000 && value.inventoryCount === value.shows.reduce((sum, s) => sum + s.seatCount, 0);
}
export function validReceipt(value, id) {
  return value && event(value.event, id) && value.event.status === 'PUBLISHED' && time(value.event.publishedAt) && rows(value);
}
export function validReview(value, organizationId, eventId) {
  return value && event(value.event, eventId) && value.event.status === 'DRAFT' && access(value.organization, organizationId)
    && typeof value.reviewToken === 'string' && /^[a-f0-9]{64}$/.test(value.reviewToken) && rows(value)
    && value.shows.every(s => s.venue && s.venue.id === s.venueId && text(s.venue.name, 160) && text(s.venue.city, 120) && validZone(s.venue.timezone) && revision(s.venue.revision));
}
export function matchesReview(receipt, review) {
  if (!review?.event || !validReceipt(receipt, review.event.id) || receipt.event.title !== review.event.title || receipt.event.category !== review.event.category
    || receipt.event.publicationRevision !== review.event.publicationRevision + 1 || receipt.inventoryCount !== review.inventoryCount || receipt.shows.length !== review.shows.length) return false;
  const indexed = new Map(review.shows.map(s => [s.id, s]));
  return receipt.shows.every(s => { const original = indexed.get(s.id); return original && ['venueId', 'status', 'revision', 'startsAt', 'priceMinor', 'currency', 'seatCount'].every(key => s[key] === original[key]); });
}
export async function publicationRequest(action, { organizationId, eventId, review, csrfToken, signal } = {}) {
  const paths = { status: 'publication/status', review: 'publication', publish: 'publish' };
  if (!Object.hasOwn(paths, action)) throw new PublicationError('INVALID_REQUEST', 400);
  if (!validId(organizationId) || !validId(eventId)) throw new PublicationError('NOT_FOUND', 404);
  if (action === 'publish' && (!validReview(review, organizationId, eventId) || review.organization.role !== 'OWNER')) throw new PublicationError('INVALID_REQUEST', 400);
  const write = action === 'publish'; let response;
  try { response = await fetch(`/api/organizers/${organizationId}/events/${eventId}/${paths[action]}`, { method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(write ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ reviewToken: review.reviewToken }) } : {}) }); }
  catch (error) { if (signal?.aborted) throw error; throw new PublicationError('CONNECTION_ERROR'); }
  let data; try { data = await response.json(); } catch { throw new PublicationError('INVALID_RESPONSE'); }
  if (!response.ok) throw new PublicationError(data?.error, response.status);
  let valid;
  if (action === 'review') valid = validReview(data, organizationId, eventId);
  else if (write) valid = matchesReview(data, review);
  else valid = data && event(data.event, eventId) && ['DRAFT', 'PUBLISHED', 'CANCELLED'].includes(data.event.status) && access(data.organization, organizationId)
    && (data.receipt === null ? data.event.publishedAt === null : validReceipt(data.receipt, eventId) && data.event.status !== 'DRAFT'
      && time(data.event.publishedAt) && Date.parse(data.event.publishedAt) === Date.parse(data.receipt.event.publishedAt)
      && data.receipt.event.publicationRevision <= data.event.publicationRevision);
  if (response.status !== 200 || !valid) throw new PublicationError('INVALID_RESPONSE');
  return data;
}
