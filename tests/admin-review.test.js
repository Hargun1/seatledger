import test from 'node:test';
import assert from 'node:assert/strict';
import { adminReviewRequest } from '../apps/web/src/admin/client.js';
import { createWorkspaceStore } from '../apps/web/src/organizers/workspace-store.js';
import { WorkspaceError } from '../apps/web/src/organizers/client.js';
const id = '11111111-1111-4111-8111-111111111111';
const row = { id, name: 'Stage', status: 'PENDING', statusVersion: 0, createdAt: '2030-01-01T00:00:00Z', approvedAt: null };

test('admin list transport is bounded, filtered, credential-safe and rejects mismatched responses', async () => {
  const original = globalThis.fetch; const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push([url, options]); return Response.json({ items: [row], nextCursor: null }); };
    assert.equal((await adminReviewRequest('list')).items[0].statusVersion, 0);
    assert.equal(calls[0][0], '/api/admin/organizers?status=PENDING&limit=20');
    assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].body, undefined);
    await assert.rejects(adminReviewRequest('list', { status: 'PENDING&role=ADMIN' })); assert.equal(calls.length, 1);
    for (const items of [[{ ...row, statusVersion: undefined }], [{ ...row, status: 'APPROVED' }], [row, row], Array(21).fill(row)]) {
      globalThis.fetch = async () => Response.json({ items, nextCursor: null });
      await assert.rejects(adminReviewRequest('list'), /confirm/);
    }
  } finally { globalThis.fetch = original; }
});
test('admin decisions carry an exact version and CSRF, and cannot silently accept another target', async () => {
  const original = globalThis.fetch; const calls = [];
  const options = { organizationId: id, status: 'APPROVED', expectedVersion: 0, csrfToken: 'session-csrf' };
  try {
    globalThis.fetch = async (url, request) => { calls.push([url, request]); return Response.json({ ...row, status: 'APPROVED', statusVersion: 1, approvedAt: row.createdAt }); };
    await assert.rejects(adminReviewRequest('decide', { ...options, expectedVersion: undefined }));
    await assert.rejects(adminReviewRequest('decide', { ...options, organizationId: '../users' })); assert.equal(calls.length, 0);
    await adminReviewRequest('decide', options);
    assert.deepEqual(JSON.parse(calls[0][1].body), { status: 'APPROVED', expectedVersion: 0 });
    assert.equal(calls[0][1].headers['X-CSRF-Token'], 'session-csrf'); assert.equal(calls[0][1].headers['X-SeatLedger-Client'], 'web');
    for (const patch of [{ id: '22222222-2222-4222-8222-222222222222' }, { statusVersion: 9 }, { status: 'SUSPENDED' }]) {
      globalThis.fetch = async () => Response.json({ ...row, status: 'APPROVED', statusVersion: 1, approvedAt: row.createdAt, ...patch });
      await assert.rejects(adminReviewRequest('decide', options), /confirm/);
    }
  } finally { globalThis.fetch = original; }
});
test('stale admin decisions clear the review data and require a new read without automatic resubmission', async () => {
  let writes = 0, reads = 0;
  const store = createWorkspaceStore({ load: async () => { reads++; return { items: [row], nextCursor: null }; },
    write: async () => { writes++; throw new WorkspaceError('REVIEW_STALE', 409); } });
  await store.refresh(); await assert.rejects(store.mutate('decide', {}), /Another decision/);
  assert.equal(store.getSnapshot().status, 'error'); assert.equal(store.getSnapshot().page, null);
  await assert.rejects(store.mutate('decide', {})); assert.equal(writes, 1); assert.equal(reads, 1);
  await store.refresh(); assert.equal(reads, 2); assert.equal(writes, 1);
});
test('admin transport never reflects arbitrary server error strings', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: 'sensitive database credentials' }, { status: 500 });
    await assert.rejects(adminReviewRequest('list'), error => error.status === 500 && !error.message.includes('credentials'));
  } finally { globalThis.fetch = original; }
});
