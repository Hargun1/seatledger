import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-error.js';
import { lockOrganizationAccess } from '../organizers/service.js';
import { publicationToken, MAX_SHOWS, MAX_INVENTORY } from './policy.js';

async function eventLock(db, organizationId, id, write) {
  const row = (await db.query(`SELECT id,title,category,status,publication_revision AS "publicationRevision",
    published_at AS "publishedAt",publication_token AS "savedToken",publication_receipt AS "savedReceipt"
    FROM events WHERE id=$1 AND organizer_id=$2 ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [id, organizationId])).rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  return row;
}
async function future(db, ids) {
  if (!(await db.query('SELECT bool_and(starts_at>clock_timestamp()) AS future FROM shows WHERE id=ANY($1::uuid[])', [ids])).rows[0].future) throw new HttpError(409, 'SHOW_TIME_PASSED');
}
async function snapshot(db, organizationId, event, write) {
  if (event.status !== 'DRAFT') throw new HttpError(409, 'EVENT_NOT_EDITABLE');
  const preliminary = (await db.query('SELECT id,venue_id FROM shows WHERE event_id=$1 AND organizer_id=$2 ORDER BY id LIMIT $3', [event.id, organizationId, MAX_SHOWS + 1])).rows;
  if (!preliminary.length) throw new HttpError(409, 'EVENT_SHOWS_REQUIRED');
  if (preliminary.length > MAX_SHOWS) throw new HttpError(409, 'PUBLICATION_TOO_LARGE');
  const venueIds = [...new Set(preliminary.map(show => show.venue_id))].sort();
  const lock = write ? 'FOR UPDATE' : 'FOR SHARE';
  const venues = (await db.query(`SELECT id,name,city,timezone,revision FROM venues
    WHERE id=ANY($1::uuid[]) AND organizer_id=$2 ORDER BY id ${lock}`, [venueIds, organizationId])).rows;
  if (venues.length !== venueIds.length) throw new HttpError(409, 'PUBLICATION_STALE');
  // Same global catalogue order as show writers: event -> sorted venues ->
  // sorted shows. No SHARE-to-UPDATE upgrades and no network calls here.
  const shows = (await db.query(`SELECT id,venue_id AS "venueId",status,revision,base_price_minor AS "priceMinor",currency,
    to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startsAt"
    FROM shows WHERE event_id=$1 AND organizer_id=$2 ORDER BY id LIMIT $3 ${lock}`, [event.id, organizationId, MAX_SHOWS + 1])).rows;
  if (shows.length !== preliminary.length || shows.some((s, i) => s.id !== preliminary[i].id || s.venueId !== preliminary[i].venue_id)) throw new HttpError(409, 'PUBLICATION_STALE');
  if (shows.some(show => show.status !== 'SCHEDULED')) throw new HttpError(409, 'SHOW_NOT_EDITABLE');
  if (shows.some(show => !Number.isInteger(show.priceMinor) || show.priceMinor < 0 || show.priceMinor > 100000000 || show.currency !== 'INR')) throw new HttpError(409, 'SHOW_PRICE_REQUIRED');
  const ids = shows.map(show => show.id);
  if ((await db.query(`SELECT EXISTS(SELECT 1 FROM show_seats WHERE show_id=ANY($1::uuid[]))
    OR EXISTS(SELECT 1 FROM reservations WHERE show_id=ANY($1::uuid[]))
    OR EXISTS(SELECT 1 FROM bookings WHERE show_id=ANY($1::uuid[])) AS used`, [ids])).rows[0].used) throw new HttpError(409, 'SHOW_IN_USE');
  for (const venue of venues) {
    const sections = (await db.query('SELECT id,name FROM venue_sections WHERE venue_id=$1 ORDER BY id LIMIT 21', [venue.id])).rows;
    const seats = (await db.query('SELECT id,section_id AS "sectionId",row_label AS "rowLabel",seat_number AS number FROM venue_seats WHERE venue_id=$1 ORDER BY id LIMIT 501', [venue.id])).rows;
    if (sections.length > 20 || seats.length > 500) throw new HttpError(409, 'LAYOUT_TOO_LARGE');
    const populated = new Set(seats.map(seat => seat.sectionId));
    if (!sections.length || !seats.length || sections.some(section => !populated.has(section.id))) throw new HttpError(409, 'VENUE_LAYOUT_REQUIRED');
    venue.sections = sections; venue.seats = seats;
  }
  const counts = new Map(venues.map(venue => [venue.id, venue.seats.length]));
  const inventoryCount = shows.reduce((sum, show) => sum + counts.get(show.venueId), 0);
  if (inventoryCount > MAX_INVENTORY) throw new HttpError(409, 'PUBLICATION_TOO_LARGE');
  await future(db, ids); // Database wall time after all catalogue locks.
  const eventData = { id: event.id, title: event.title, category: event.category, status: event.status, publicationRevision: event.publicationRevision };
  const reviewToken = publicationToken({ organizationId, event: eventData, shows, venues });
  const summary = shows.map(show => {
    const venue = venues.find(venue => venue.id === show.venueId);
    return { ...show, seatCount: counts.get(show.venueId), venue: { id: venue.id, name: venue.name, city: venue.city, timezone: venue.timezone, revision: venue.revision } };
  });
  return { event: eventData, shows: summary, inventoryCount, reviewToken };
}

export async function reviewPublication(db, session, organizationId, eventId) {
  const organization = await lockOrganizationAccess(db, session, organizationId);
  const event = await eventLock(db, organizationId, eventId, false);
  return { ...await snapshot(db, organizationId, event, false), organization };
}
export async function publicationStatus(db, session, organizationId, eventId) {
  const organization = await lockOrganizationAccess(db, session, organizationId);
  const current = await eventLock(db, organizationId, eventId, false);
  const { savedToken, savedReceipt, ...event } = current;
  // Historical receipt, not a live availability count. Never expose savedToken
  // or rebuild legacy inventory just to make a status response look complete.
  return { event, organization, receipt: savedReceipt };
}
export async function publishEvent(db, session, organizationId, eventId, { reviewToken }) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  const event = await eventLock(db, organizationId, eventId, true);
  if (event.status === 'PUBLISHED' && event.savedToken === reviewToken && event.savedReceipt) return event.savedReceipt;
  if (event.status !== 'DRAFT') throw new HttpError(409, 'EVENT_NOT_EDITABLE');
  const review = await snapshot(db, organizationId, event, true);
  if (review.reviewToken !== reviewToken) throw new HttpError(409, 'PUBLICATION_STALE');
  const ids = review.shows.map(show => show.id);
  const inserted = await db.query(`INSERT INTO show_seats(show_id,venue_seat_id,venue_id,state,price_minor,currency)
    SELECT s.id,v.id,s.venue_id,'AVAILABLE',s.base_price_minor,s.currency
    FROM shows s JOIN venue_seats v ON v.venue_id=s.venue_id
    WHERE s.event_id=$1 AND s.organizer_id=$2 AND s.id=ANY($3::uuid[]) ORDER BY s.id,v.id`, [eventId, organizationId, ids]);
  if (inserted.rowCount !== review.inventoryCount) throw new HttpError(409, 'PUBLICATION_STALE');
  await future(db, ids); // Do not publish if copying crossed a start boundary.
  const result = (await db.query(`WITH stamp AS (SELECT clock_timestamp() AS at)
    UPDATE events SET status='PUBLISHED',publication_revision=publication_revision+1,published_at=stamp.at,publication_token=$3,
    publication_receipt=jsonb_build_object('event',jsonb_build_object('id',id,'title',title,'category',category,
      'status','PUBLISHED','publicationRevision',publication_revision+1,'publishedAt',stamp.at),
      'shows',$4::jsonb,'inventoryCount',$5::integer)
    FROM stamp WHERE id=$1 AND organizer_id=$2 RETURNING publication_receipt AS receipt`,
  [eventId, organizationId, reviewToken, JSON.stringify(review.shows.map(({ venue, ...show }) => show)), review.inventoryCount])).rows[0].receipt;
  await db.query(`INSERT INTO audit_events(operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,organizer_id,metadata)
    VALUES($1,'USER',$2,'event.published','event',$3,$4,$5)`, [randomUUID(), session.user.id, eventId, organizationId,
    { shows: ids.length, inventory: review.inventoryCount, fromRevision: event.publicationRevision, toRevision: result.event.publicationRevision }]);
  return result;
}
