import { z } from 'zod';
import { HttpError } from '../http-error.js';

export const organizerId = z.uuid();
export const pageInput = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  after: z.uuid().optional()
}).strict();
export const reviewInput = pageInput.extend({ status: z.enum(['PENDING', 'APPROVED', 'SUSPENDED']).default('PENDING') });
export const organizationInput = z.object({ name: z.string().trim().min(1).max(160) }).strict();
export const decisionInput = z.object({
  status: z.enum(['APPROVED', 'SUSPENDED']),
  expectedVersion: z.number().int().min(0).max(2147483647)
}).strict();
const title = z.string().trim().min(1).max(200);
const category = z.string().trim().min(1).max(60);
export const draftInput = z.object({ title, category }).strict();
export const draftPatch = z.object({ title: title.optional(), category: category.optional() }).strict()
  .refine(value => Object.keys(value).length > 0);

export function parseInput(schema, value, { missing = false } = {}) {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(missing ? 404 : 400, missing ? 'NOT_FOUND' : 'INVALID_REQUEST');
  return result.data;
}
export function requireAdmin(session) {
  if (session.user.role !== 'ADMIN') throw new HttpError(403, 'ADMIN_REQUIRED');
}
export function requireMembership(organization, membership, { owner = false } = {}) {
  if (!organization || !membership || membership.revoked_at || !['OWNER', 'STAFF'].includes(membership.role)) throw new HttpError(404, 'NOT_FOUND');
  if (organization.status !== 'APPROVED') throw new HttpError(403, 'ORGANIZER_NOT_APPROVED');
  if (owner && membership.role !== 'OWNER') throw new HttpError(403, 'OWNER_REQUIRED');
}
export function validateDecision(current, target) {
  if (!['PENDING', 'APPROVED', 'SUSPENDED'].includes(current) || !['APPROVED', 'SUSPENDED'].includes(target)) {
    throw new HttpError(409, 'INVALID_ORGANIZER_TRANSITION');
  }
  if (current === target) return false;
  if ((current === 'PENDING' && target === 'APPROVED') ||
      (current === 'APPROVED' && target === 'SUSPENDED') ||
      (current === 'SUSPENDED' && target === 'APPROVED')) return true;
  throw new HttpError(409, 'INVALID_ORGANIZER_TRANSITION');
}

// UUID order is stable, not chronological. Fetch one extra row to detect more.
export function pageResult(rows, limit) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1).id : null };
}
