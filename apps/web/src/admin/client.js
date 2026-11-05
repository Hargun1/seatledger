import { WorkspaceError, validId } from '../organizers/client.js';

export const reviewStatuses = Object.freeze(['PENDING', 'APPROVED', 'SUSPENDED']);
const version = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const organization = value => value && validId(value.id) && typeof value.name === 'string'
  && value.name.trim().length > 0 && value.name.length <= 160 && reviewStatuses.includes(value.status)
  && version(value.statusVersion) && time(value.createdAt)
  && (value.approvedAt === null || time(value.approvedAt))
  && (value.status !== 'PENDING' || value.approvedAt === null)
  && (value.status !== 'APPROVED' || time(value.approvedAt));

export async function adminReviewRequest(action, { status = 'PENDING', cursor, organizationId, expectedVersion, csrfToken, signal } = {}) {
  let path, method;
  if (action === 'list') {
    if (!reviewStatuses.includes(status) || (cursor && !validId(cursor))) throw new WorkspaceError('INVALID_REQUEST', 400);
    path = `/admin/organizers?status=${status}&limit=20${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`; method = 'GET';
  } else if (action === 'decide') {
    if (!validId(organizationId) || !['APPROVED', 'SUSPENDED'].includes(status) || !version(expectedVersion)) throw new WorkspaceError('INVALID_REQUEST', 400);
    path = `/admin/organizers/${organizationId}/status`; method = 'POST';
  } else throw new WorkspaceError('INVALID_REQUEST', 400);
  let response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ status, expectedVersion }) } : {})
    });
  } catch (error) { if (signal?.aborted) throw error; throw new WorkspaceError('CONNECTION_ERROR'); }
  let data;
  try { data = await response.json(); } catch { throw new WorkspaceError('INVALID_RESPONSE'); }
  if (!response.ok) throw new WorkspaceError(data?.error, response.status);
  let valid;
  if (action === 'list') {
    valid = data && Array.isArray(data.items) && data.items.length <= 20 && data.items.every(row => organization(row) && row.status === status)
      && new Set(data.items.map(row => row.id)).size === data.items.length
      && (data.nextCursor === null || (validId(data.nextCursor) && data.items.at(-1)?.id === data.nextCursor));
  } else valid = organization(data) && data.id === organizationId && data.status === status
    && [expectedVersion, expectedVersion + 1].includes(data.statusVersion);
  if (response.status !== 200 || !valid) throw new WorkspaceError('INVALID_RESPONSE');
  return data;
}
