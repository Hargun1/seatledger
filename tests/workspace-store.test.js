import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore } from '../apps/web/src/organizers/workspace-store.js';
import { workspaceRequest, WorkspaceError } from '../apps/web/src/organizers/client.js';
const page = { items: [], nextCursor: null };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('older workspace reads cannot overwrite a new page even when abort is ignored', async () => {
  const old = deferred(); let reads = 0;
  const store = createWorkspaceStore({ load: () => ++reads === 1 ? old.promise : page });
  const first = store.refresh(); await store.refresh({ cursor: 'new-cursor' });
  old.resolve({ items: ['stale'], nextCursor: null }); await first;
  assert.deepEqual(store.getSnapshot().page, page); assert.equal(store.getSnapshot().cursor, 'new-cursor');
});
test('double saves are fenced synchronously and a successful save refreshes by GET only', async () => {
  const pending = deferred(); let writes = 0, reads = 0;
  const store = createWorkspaceStore({ load: async () => { reads++; return page; }, write: async () => { writes++; return pending.promise; } });
  await store.refresh(); const saving = store.mutate('create', {}, 'Saved.');
  await assert.rejects(store.mutate('create', {}), /busy/);
  await store.refresh(); assert.equal(reads, 1);
  pending.resolve({ id: 'saved' }); await saving;
  assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(store.getSnapshot().notice, 'Saved.');
});
test('lost save response requires a read before resubmission and does not replay a mutation', async () => {
  let writes = 0;
  const store = createWorkspaceStore({ load: async () => page, write: async () => { writes++; throw new WorkspaceError('CONNECTION_ERROR'); } });
  await store.refresh(); await assert.rejects(store.mutate('create', {}));
  assert.equal(store.getSnapshot().status, 'uncertain'); assert.equal(store.getSnapshot().page, null);
  await assert.rejects(store.mutate('create', {})); assert.equal(writes, 1);
  await store.refresh(); assert.equal(store.getSnapshot().status, 'ready'); assert.equal(writes, 1);
});
test('access failure hides stale data and a cancelled save cannot repaint another workspace', async () => {
  let recovered = 0;
  const store = createWorkspaceStore({ load: async () => page, write: async () => { throw new WorkspaceError('AUTH_REQUIRED', 401); }, onAuthRequired: () => { recovered++; } });
  await store.refresh(); await assert.rejects(store.mutate('update', {}));
  assert.equal(recovered, 1); assert.equal(store.getSnapshot().page, null);
  const pending = deferred();
  const other = createWorkspaceStore({ load: async () => page, write: () => pending.promise });
  await other.refresh(); const saving = other.mutate('create', {}, 'Old result'); other.cancel();
  pending.resolve({}); await saving; assert.equal(other.getSnapshot().notice, '');
});
test('failed post-save read keeps a known success separate from an uncertain write', async () => {
  let reads = 0;
  const store = createWorkspaceStore({ load: async () => { if (++reads > 1) throw new WorkspaceError('CONNECTION_ERROR'); return page; }, write: async () => ({}) });
  await store.refresh(); await store.mutate('create', {}, 'Draft saved.');
  assert.equal(store.getSnapshot().status, 'error'); assert.equal(store.getSnapshot().notice, 'Draft saved.');
});
test('workspace transport uses cookie/CSRF boundaries, rejects invalid data and sanitizes server messages', async () => {
  const original = globalThis.fetch, id = '11111111-1111-4111-8111-111111111111';
  let calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push([url, options]);
      return Response.json({ id, title: 'Evening', category: 'Talks', status: 'DRAFT', createdAt: '2030-01-01T00:00:00Z' }, { status: 201 });
    };
    await workspaceRequest('create', { organizationId: id, body: { title: 'Evening', category: 'Talks' }, csrfToken: 'test-csrf' });
    assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].cache, 'no-store');
    assert.equal(calls[0][1].headers['X-CSRF-Token'], 'test-csrf'); assert.equal(calls[0][1].headers['X-SeatLedger-Client'], 'web');
    await assert.rejects(workspaceRequest('events', { organizationId: '../admin' })); assert.equal(calls.length, 1);
    globalThis.fetch = async () => Response.json({ items: [], nextCursor: null });
    await assert.rejects(workspaceRequest('events', { organizationId: id }), /confirm/);
    globalThis.fetch = async () => Response.json({ error: 'raw private error including credentials' }, { status: 500 });
    await assert.rejects(workspaceRequest('mine'), error => !error.message.includes('credentials') && error.status === 500);
  } finally { globalThis.fetch = original; }
});
