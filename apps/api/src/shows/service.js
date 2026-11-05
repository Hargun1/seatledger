import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-error.js';
import { lockOrganizationAccess } from '../organizers/service.js';
import { pageResult } from '../organizers/policy.js';
import { MAX_SHOWS } from '../publication/policy.js';

const columns = 'id,event_id AS "eventId",venue_id AS "venueId",starts_at AS "startsAt",status,revision,base_price_minor AS "priceMinor",currency';
async function advanceSchedule(db, eventId) {
  // Caller already owns the event UPDATE lock. Include create/delete round
  // trips in publication review identity, even if the final rows look equal.
  await db.query('UPDATE events SET publication_revision=publication_revision+1 WHERE id=$1', [eventId]);
}
async function audit(db, session, organizationId, id, action, metadata = {}) {
  await db.query(`INSERT INTO audit_events(operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,organizer_id,metadata)
    VALUES($1,'USER',$2,$3,'show',$4,$5,$6)`, [randomUUID(), session.user.id, action, id, organizationId, metadata]);
}
async function lockEvent(db, organizationId, eventId, write = false) {
  const event = (await db.query(`SELECT id,title,category,status FROM events WHERE id=$1 AND organizer_id=$2 ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [eventId, organizationId])).rows[0];
  if (!event) throw new HttpError(404, 'NOT_FOUND');
  if (write && event.status !== 'DRAFT') throw new HttpError(409, 'EVENT_NOT_EDITABLE');
  return event;
}
async function lockVenue(db, organizationId, id) {
  const venue = (await db.query('SELECT id,revision FROM venues WHERE id=$1 AND organizer_id=$2 FOR UPDATE', [id, organizationId])).rows[0];
  if (!venue) throw new HttpError(404, 'NOT_FOUND');
  return venue;
}
async function readShow(db, organizationId, eventId, id, locked = false) {
  const show = (await db.query(`SELECT ${columns} FROM shows WHERE id=$1 AND event_id=$2 AND organizer_id=$3 ${locked ? 'FOR UPDATE' : ''}`, [id, eventId, organizationId])).rows[0];
  if (!show) throw new HttpError(404, 'NOT_FOUND');
  return show;
}
async function requireFuture(db, startsAt) {
  // Separate statement after relevant locks: transaction-start time is stale
  // if this request waited. PostgreSQL decides, not the browser or API clock.
  if (!(await db.query('SELECT $1::timestamptz > clock_timestamp() AS future', [startsAt])).rows[0].future) throw new HttpError(409, 'SHOW_TIME_PASSED');
}
async function showInUse(db, id) {
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM show_seats WHERE show_id=$1)
    OR EXISTS(SELECT 1 FROM reservations WHERE show_id=$1)
    OR EXISTS(SELECT 1 FROM bookings WHERE show_id=$1) AS used`, [id])).rows[0].used;
}
async function requireUnused(db, id) {
  if (await showInUse(db, id)) throw new HttpError(409, 'SHOW_IN_USE');
}
async function requireLayout(db, venueId) {
  const sections = (await db.query('SELECT id FROM venue_sections WHERE venue_id=$1 ORDER BY id LIMIT 21', [venueId])).rows;
  const seats = (await db.query('SELECT section_id AS "sectionId" FROM venue_seats WHERE venue_id=$1 LIMIT 501', [venueId])).rows;
  if (sections.length > 20 || seats.length > 500) throw new HttpError(409, 'LAYOUT_TOO_LARGE');
  const populated = new Set(seats.map(seat => seat.sectionId));
  if (!sections.length || !seats.length || sections.some(section => !populated.has(section.id))) throw new HttpError(409, 'VENUE_LAYOUT_REQUIRED');
}
async function lockEditableShow(db, session, organizationId, eventId, id, expectedRevision) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  await lockEvent(db, organizationId, eventId, true);
  // Discover immutable API venue identity without locking a child first.
  // Every cooperating writer takes event -> venue -> show, in that order.
  const preliminary = await readShow(db, organizationId, eventId, id);
  await lockVenue(db, organizationId, preliminary.venueId);
  const current = await readShow(db, organizationId, eventId, id, true);
  if (current.venueId !== preliminary.venueId) throw new HttpError(409, 'SHOW_STALE');
  if (current.revision !== expectedRevision) throw new HttpError(409, 'SHOW_STALE');
  if (current.status !== 'SCHEDULED') throw new HttpError(409, 'SHOW_NOT_EDITABLE');
  await requireUnused(db, id);
  return current;
}

export async function listShows(db, session, organizationId, eventId, { limit, after }) {
  const organization = await lockOrganizationAccess(db, session, organizationId);
  const event = await lockEvent(db, organizationId, eventId);
  const rows = (await db.query(`SELECT ${columns} FROM shows WHERE event_id=$1 AND organizer_id=$2
    AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`, [eventId, organizationId, after ?? null, limit + 1])).rows;
  return { ...pageResult(rows, limit), organization, event };
}
export async function getShow(db, session, organizationId, eventId, id) {
  const organization = await lockOrganizationAccess(db, session, organizationId);
  const event = await lockEvent(db, organizationId, eventId);
  return { ...await readShow(db, organizationId, eventId, id), inUse: await showInUse(db, id), organization, event };
}
export async function createShow(db, session, organizationId, eventId, input) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  await lockEvent(db, organizationId, eventId, true);
  if ((await db.query('SELECT id FROM shows WHERE event_id=$1 ORDER BY id LIMIT $2', [eventId, MAX_SHOWS])).rowCount >= MAX_SHOWS) throw new HttpError(409, 'EVENT_SHOW_LIMIT');
  const venue = await lockVenue(db, organizationId, input.venueId);
  if (venue.revision !== input.expectedVenueRevision) throw new HttpError(409, 'VENUE_STALE');
  await requireLayout(db, venue.id);
  await requireFuture(db, input.startsAt);
  const show = (await db.query(`INSERT INTO shows(event_id,venue_id,organizer_id,starts_at,base_price_minor,currency)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [eventId, venue.id, organizationId, input.startsAt, input.priceMinor, input.currency])).rows[0];
  await advanceSchedule(db, eventId);
  await audit(db, session, organizationId, show.id, 'show.created', { eventId, venueId: venue.id, venueRevision: venue.revision });
  return show; // Deliberately no show_seats: publishing owns inventory creation.
}
export async function patchShow(db, session, organizationId, eventId, id, { expectedRevision, ...input }) {
  const current = await lockEditableShow(db, session, organizationId, eventId, id, expectedRevision);
  const priceMinor = input.priceMinor ?? current.priceMinor;
  // Preserve an imported timestamp's PostgreSQL microseconds on price-only
  // edits. Never write a pg Date round-trip back over an unchanged instant.
  const timing = (await db.query(`SELECT COALESCE($2::timestamptz,starts_at)>clock_timestamp() AS future,
    ($2::timestamptz IS NULL OR starts_at=$2::timestamptz) AS same_time FROM shows WHERE id=$1`, [id, input.startsAt ?? null])).rows[0];
  if (!timing.future) throw new HttpError(409, 'SHOW_TIME_PASSED');
  // Imported shows without a uniform price require a deliberate price input.
  if (priceMinor === null || (current.currency !== null && current.currency !== 'INR')) throw new HttpError(409, 'SHOW_PRICE_REQUIRED');
  if (timing.same_time && priceMinor === current.priceMinor && current.currency === 'INR') return current;
  const show = (await db.query(`UPDATE shows SET starts_at=COALESCE($2::timestamptz,starts_at),base_price_minor=$3,currency='INR',revision=revision+1
    WHERE id=$1 RETURNING ${columns}`, [id, input.startsAt ?? null, priceMinor])).rows[0];
  await advanceSchedule(db, eventId);
  await audit(db, session, organizationId, id, 'show.updated', { fromRevision: current.revision, toRevision: show.revision });
  return show;
}
export async function deleteShow(db, session, organizationId, eventId, id, { expectedRevision }) {
  const current = await lockEditableShow(db, session, organizationId, eventId, id, expectedRevision);
  await db.query('DELETE FROM shows WHERE id=$1', [id]);
  await advanceSchedule(db, eventId);
  await audit(db, session, organizationId, id, 'show.deleted', { eventId, venueId: current.venueId, revision: current.revision });
  return { id, deleted: true };
}
