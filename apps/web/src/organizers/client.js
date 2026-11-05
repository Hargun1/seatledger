const messages = {
  INVALID_REQUEST: 'Check the details and try again.',
  AUTH_REQUIRED: 'Your session has ended. Please sign in again.',
  CSRF_REJECTED: 'Your session changed. Reload the workspace before trying again.',
  ORIGIN_REJECTED: 'Open the configured SeatLedger address to make changes.',
  NOT_FOUND: 'This workspace is unavailable to your account.',
  ORGANIZER_NOT_APPROVED: 'Event access is closed while this organization is pending or suspended.',
  OWNER_REQUIRED: 'Only an active owner can change drafts.',
  ADMIN_REQUIRED: 'Administrator access is required to review organizations.',
  REVIEW_STALE: 'Another decision changed this organization. Reload the review list before deciding again.',
  INVALID_ORGANIZER_TRANSITION: 'This decision is not allowed for the current organization status.',
  PENDING_REQUEST_EXISTS: 'You already have a pending organization request. Reload to check its status.',
  EVENT_NOT_EDITABLE: 'This event is no longer a draft. Reload to see its current status.',
  ACCESS_BUSY: 'The workspace is busy. Reload to check the latest state before trying again.',
  CONNECTION_ERROR: 'We could not reach the workspace.',
  INVALID_RESPONSE: 'We could not confirm the workspace response.'
};
export class WorkspaceError extends Error {
  constructor(code, status = 0) {
    const safeCode = typeof code === 'string' ? code : 'UNKNOWN_ERROR';
    super(Object.hasOwn(messages, safeCode) ? messages[safeCode] : 'The workspace request could not be completed.');
    this.code = safeCode; this.status = status;
  }
}
export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const organization = value => value && validId(value.id) && text(value.name, 160)
  && ['PENDING', 'APPROVED', 'SUSPENDED'].includes(value.status);
const membership = value => organization(value) && ['OWNER', 'STAFF'].includes(value.role);
const event = value => value && validId(value.id) && text(value.title, 200) && text(value.category, 60)
  && ['DRAFT', 'PUBLISHED', 'CANCELLED'].includes(value.status) && timestamp(value.createdAt);
const list = (value, item) => value && Array.isArray(value.items) && value.items.length <= 20 && value.items.every(item)
  && new Set(value.items.map(row => row.id)).size === value.items.length
  && (value.nextCursor === null || (validId(value.nextCursor) && value.items.at(-1)?.id === value.nextCursor));

export async function workspaceRequest(action, { organizationId, eventId, cursor, body, csrfToken, signal } = {}) {
  const scoped = ['events', 'create', 'update'].includes(action);
  if ((scoped && !validId(organizationId)) || (action === 'update' && !validId(eventId)) || (cursor && !validId(cursor))) {
    throw new WorkspaceError('NOT_FOUND', 404);
  }
  let path, method, validate;
  if (action === 'mine') { path = '/organizers'; method = 'GET'; validate = value => list(value, membership); }
  else if (action === 'request') { path = '/organizers'; method = 'POST'; validate = value => organization(value) && value.status === 'PENDING'; }
  else if (action === 'events') {
    path = `/organizers/${organizationId}/events`; method = 'GET';
    validate = value => list(value, event) && membership(value.organization) && value.organization.id === organizationId && value.organization.status === 'APPROVED';
  } else if (action === 'create' || action === 'update') {
    path = `/organizers/${organizationId}/events${action === 'update' ? `/${eventId}` : ''}`;
    method = action === 'create' ? 'POST' : 'PATCH';
    validate = value => event(value) && value.status === 'DRAFT' && (action !== 'update' || value.id === eventId);
  } else throw new WorkspaceError('INVALID_REQUEST', 400);
  const write = method !== 'GET';
  if (!write) path += `?limit=20${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
  const headers = write ? { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken } : {};
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      ...(write ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new WorkspaceError('CONNECTION_ERROR');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new WorkspaceError('INVALID_RESPONSE'); }
  if (!response.ok) throw new WorkspaceError(data?.error, response.status);
  const expectedStatus = ['request', 'create'].includes(action) ? 201 : 200;
  if (response.status !== expectedStatus || !validate(data)) throw new WorkspaceError('INVALID_RESPONSE');
  return data;
}
