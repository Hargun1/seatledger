import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-error.js';
import { requireAdmin, requireMembership, validateDecision, pageResult } from './policy.js';

const organizationColumns = 'id,name,status,status_version AS "statusVersion",created_at AS "createdAt",approved_at AS "approvedAt"';
const eventColumns = 'id,title,category,status,created_at AS "createdAt"';

async function audit(db, userId, action, type, id, organizationId, metadata = {}) {
  await db.query(`INSERT INTO audit_events
    (operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,organizer_id,metadata)
    VALUES ($1,'USER',$2,$3,$4,$5,$6,$7)`,
  [randomUUID(), userId, action, type, id, organizationId, metadata]);
}

export async function requestOrganization(db, session, input) {
  // The caller holds the actor FOR UPDATE from the start, serializing this
  // user's submissions without a SHARE-to-UPDATE lock upgrade.
  const pending = await db.query(`SELECT o.id FROM organizers o JOIN organizer_memberships m ON m.organizer_id=o.id
    WHERE m.user_id=$1 AND m.role='OWNER' AND m.revoked_at IS NULL AND o.status='PENDING' LIMIT 1`, [session.user.id]);
  if (pending.rowCount) throw new HttpError(409, 'PENDING_REQUEST_EXISTS');
  const organization = (await db.query(`INSERT INTO organizers (name) VALUES ($1) RETURNING ${organizationColumns}`, [input.name])).rows[0];
  await db.query("INSERT INTO organizer_memberships (organizer_id,user_id,role) VALUES ($1,$2,'OWNER')", [organization.id, session.user.id]);
  await audit(db, session.user.id, 'organizer.requested', 'organizer', organization.id, organization.id);
  return organization;
}

export async function listMine(db, session, { limit, after }) {
  const rows = (await db.query(`SELECT o.id,o.name,o.status,o.created_at AS "createdAt",o.approved_at AS "approvedAt",m.role
    FROM organizers o JOIN organizer_memberships m ON m.organizer_id=o.id
    WHERE m.user_id=$1 AND m.revoked_at IS NULL AND ($2::uuid IS NULL OR o.id>$2)
    ORDER BY o.id LIMIT $3`, [session.user.id, after ?? null, limit + 1])).rows;
  return pageResult(rows, limit);
}

export async function listReview(db, session, { status, limit, after }) {
  requireAdmin(session);
  const rows = (await db.query(`SELECT ${organizationColumns} FROM organizers
    WHERE status=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [status, after ?? null, limit + 1])).rows;
  return pageResult(rows, limit);
}

export async function decideOrganization(db, session, id, { status, expectedVersion }) {
  requireAdmin(session);
  const current = (await db.query(`SELECT ${organizationColumns} FROM organizers WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!current) throw new HttpError(404, 'NOT_FOUND');
  if (current.statusVersion !== expectedVersion) throw new HttpError(409, 'REVIEW_STALE');
  if (!validateDecision(current.status, status)) return current;
  const organization = status === 'APPROVED'
    ? (await db.query(`UPDATE organizers SET status=$2,approved_by=$3,approved_at=clock_timestamp() WHERE id=$1 RETURNING ${organizationColumns}`, [id, status, session.user.id])).rows[0]
    : (await db.query(`UPDATE organizers SET status=$2 WHERE id=$1 RETURNING ${organizationColumns}`, [id, status])).rows[0];
  await audit(db, session.user.id, status === 'APPROVED' ? 'organizer.approved' : 'organizer.suspended', 'organizer', id, id,
    { from: current.status, to: status, fromVersion: current.statusVersion, toVersion: organization.statusVersion });
  return organization;
}

export async function lockOrganizationAccess(db, session, id, options) {
  // Every future membership/status writer must use organization-before-membership.
  const organization = (await db.query('SELECT id,name,status FROM organizers WHERE id=$1 FOR SHARE', [id])).rows[0];
  const membership = organization && (await db.query(`SELECT role,revoked_at FROM organizer_memberships
    WHERE organizer_id=$1 AND user_id=$2 FOR SHARE`, [id, session.user.id])).rows[0];
  requireMembership(organization, membership, options);
  return { ...organization, role: membership.role };
}

export async function listEvents(db, session, id, { limit, after }) {
  const organization = await lockOrganizationAccess(db, session, id);
  const rows = (await db.query(`SELECT ${eventColumns} FROM events
    WHERE organizer_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [id, after ?? null, limit + 1])).rows;
  return { ...pageResult(rows, limit), organization };
}

export async function getEvent(db, session, organizationId, eventId) {
  await lockOrganizationAccess(db, session, organizationId);
  const event = (await db.query(`SELECT ${eventColumns} FROM events WHERE id=$1 AND organizer_id=$2`, [eventId, organizationId])).rows[0];
  if (!event) throw new HttpError(404, 'NOT_FOUND');
  return event;
}

export async function createDraft(db, session, organizationId, input) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  const event = (await db.query(`INSERT INTO events (title,category,organizer_id,status) VALUES ($1,$2,$3,'DRAFT') RETURNING ${eventColumns}`,
    [input.title, input.category, organizationId])).rows[0];
  await audit(db, session.user.id, 'event.created', 'event', event.id, organizationId);
  return event;
}

export async function updateDraft(db, session, organizationId, eventId, input) {
  await lockOrganizationAccess(db, session, organizationId, { owner: true });
  const existing = (await db.query(`SELECT ${eventColumns} FROM events WHERE id=$1 AND organizer_id=$2 FOR UPDATE`, [eventId, organizationId])).rows[0];
  if (!existing) throw new HttpError(404, 'NOT_FOUND');
  if (existing.status !== 'DRAFT') throw new HttpError(409, 'EVENT_NOT_EDITABLE');
  const title = input.title ?? existing.title, category = input.category ?? existing.category;
  if (title === existing.title && category === existing.category) return existing;
  const event = (await db.query(`UPDATE events SET title=$3,category=$4,publication_revision=publication_revision+1 WHERE id=$1 AND organizer_id=$2 RETURNING ${eventColumns}`,
    [eventId, organizationId, title, category])).rows[0];
  await audit(db, session.user.id, 'event.updated', 'event', eventId, organizationId);
  return event;
}
