import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-error.js';
import { lockOrganizationAccess } from '../organizers/service.js';
import { pageResult } from '../organizers/policy.js';

const columns = 'id,name,city,timezone,revision';
async function audit(db, session, organizationId, id, action, metadata = {}) {
  await db.query(`INSERT INTO audit_events(operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,organizer_id,metadata)
    VALUES($1,'USER',$2,$3,'venue',$4,$5,$6)`, [randomUUID(), session.user.id, action, id, organizationId, metadata]);
}
async function lockVenue(db, organizationId, id, write = false) {
  const result = await db.query(`SELECT ${columns} FROM venues WHERE id=$1 AND organizer_id=$2 ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [id, organizationId]);
  if (!result.rowCount) throw new HttpError(404, 'NOT_FOUND');
  return result.rows[0];
}
async function hasShows(db, id) {
  return (await db.query('SELECT EXISTS(SELECT 1 FROM shows WHERE venue_id=$1) AS used', [id])).rows[0].used;
}
async function editable(db, venue, expectedRevision) {
  if (venue.revision !== expectedRevision) throw new HttpError(409, 'VENUE_STALE');
  // Separate statement after the venue lock: see a show that committed while
  // this operation was waiting. All statuses count, including cancelled shows.
  if (await hasShows(db, venue.id)) throw new HttpError(409, 'VENUE_IN_USE');
}
async function layout(db, id) {
  const sections = (await db.query('SELECT id,name FROM venue_sections WHERE venue_id=$1 ORDER BY name,id LIMIT 21', [id])).rows;
  const seats = (await db.query(`SELECT id,section_id AS "sectionId",row_label AS "rowLabel",seat_number AS number
    FROM venue_seats WHERE venue_id=$1 ORDER BY section_id,row_label,seat_number,id LIMIT 501`, [id])).rows;
  if (sections.length > 20 || seats.length > 500) throw new HttpError(409, 'LAYOUT_TOO_LARGE');
  const grouped = new Map(sections.map(section => [section.id, []]));
  for (const seat of seats) { const { sectionId, ...item } = seat; grouped.get(sectionId).push(item); }
  return sections.map(section => ({ ...section, seats: grouped.get(section.id) }));
}

export async function listVenues(db, session, organizationId, { limit, after }) {
  const organization = await lockOrganizationAccess(db, session, organizationId);
  const rows = (await db.query(`SELECT ${columns} FROM venues WHERE organizer_id=$1 AND ($2::uuid IS NULL OR id>$2)
    ORDER BY id LIMIT $3`, [organizationId, after ?? null, limit + 1])).rows;
  return { ...pageResult(rows, limit), organization };
}
export async function getVenue(db, session, organizationId, id) {
  const organization = await lockOrganizationAccess(db, session, organizationId);
  const venue = await lockVenue(db, organizationId, id);
  return { ...venue, hasShows: await hasShows(db, id), sections: await layout(db, id), organization };
}
export async function createVenue(db, session, organizationId, input) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  const venue = (await db.query(`INSERT INTO venues(name,city,timezone,organizer_id) VALUES($1,$2,$3,$4) RETURNING ${columns}`,
    [input.name, input.city, input.timezone, organizationId])).rows[0];
  await audit(db, session, organizationId, venue.id, 'venue.created');
  return venue;
}
export async function patchVenue(db, session, organizationId, id, { expectedRevision, ...input }) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  const current = await lockVenue(db, organizationId, id, true); await editable(db, current, expectedRevision);
  const name = input.name ?? current.name, city = input.city ?? current.city, timezone = input.timezone ?? current.timezone;
  if (name === current.name && city === current.city && timezone === current.timezone) return current;
  const venue = (await db.query(`UPDATE venues SET name=$3,city=$4,timezone=$5,revision=revision+1 WHERE id=$1 AND organizer_id=$2 RETURNING ${columns}`,
    [id, organizationId, name, city, timezone])).rows[0];
  await audit(db, session, organizationId, id, 'venue.updated', { fromRevision: current.revision, toRevision: venue.revision });
  return venue;
}
export async function replaceLayout(db, session, organizationId, id, { expectedRevision, sections }) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  const current = await lockVenue(db, organizationId, id, true); await editable(db, current, expectedRevision);
  // Unused venue only. Replacement issues fresh physical seat IDs; a future
  // show writer must lock this venue before inspecting/copying this layout.
  await db.query('DELETE FROM venue_seats WHERE venue_id=$1', [id]);
  await db.query('DELETE FROM venue_sections WHERE venue_id=$1', [id]);
  const normalized = sections.map(section => ({ ...section, id: randomUUID() }));
  await db.query(`INSERT INTO venue_sections(id,venue_id,name)
    SELECT s.id,$1,s.name FROM unnest($2::uuid[],$3::text[]) AS s(id,name)`, [id, normalized.map(section => section.id), normalized.map(section => section.name)]);
  const rows = normalized.flatMap(section => section.rows.map(row => ({ sectionId: section.id, label: row.label, seats: row.seats })));
  await db.query(`INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number)
    SELECT $1,r."sectionId",r.label,n FROM jsonb_to_recordset($2::jsonb) AS r("sectionId" uuid,label text,seats integer)
    CROSS JOIN LATERAL generate_series(1,r.seats) AS n`, [id, JSON.stringify(rows)]);
  const venue = (await db.query(`UPDATE venues SET revision=revision+1 WHERE id=$1 AND organizer_id=$2 RETURNING ${columns}`, [id, organizationId])).rows[0];
  await audit(db, session, organizationId, id, 'venue.layout_replaced', { fromRevision: current.revision, toRevision: venue.revision,
    sections: normalized.length, seats: rows.reduce((sum, row) => sum + row.seats, 0) });
  return { ...venue, hasShows: false, sections: await layout(db, id) };
}
export async function deleteVenue(db, session, organizationId, id, { expectedRevision }) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  const current = await lockVenue(db, organizationId, id, true); await editable(db, current, expectedRevision);
  await db.query('DELETE FROM venue_seats WHERE venue_id=$1', [id]);
  await db.query('DELETE FROM venue_sections WHERE venue_id=$1', [id]);
  await db.query('DELETE FROM venues WHERE id=$1 AND organizer_id=$2', [id, organizationId]);
  await audit(db, session, organizationId, id, 'venue.deleted', { revision: current.revision });
  return { id, deleted: true };
}
