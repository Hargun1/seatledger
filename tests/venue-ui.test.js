import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetadata, validatePlan, planFromSaved, previewSections } from '../apps/web/src/venues/model.js';
import { venueRequest } from '../apps/web/src/venues/client.js';
import { venueInput, layoutInput } from '../apps/api/src/venues/policy.js';
import { createWorkspaceStore } from '../apps/web/src/organizers/workspace-store.js';
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const venue = { id, name: 'Small Stage', city: 'Bengaluru', timezone: 'Asia/Kolkata', revision: 0 };
const access = { id, name: 'Team', status: 'APPROVED', role: 'OWNER' };
const section = { name: ' Main ', key: 'client-only-section', rows: [{ label: ' A ', seats: '3', key: 'client-only-row' }] };

test('venue UI metadata validation agrees with the strict API normalization', () => {
  const checked = validateMetadata({ name: ' Stage ', city: ' City ', timezone: ' UTC ' });
  assert.deepEqual(checked.errors, {}); assert.deepEqual(venueInput.parse(checked.data), checked.data);
  assert.ok(validateMetadata({ name: '', city: '', timezone: '+05:30' }).errors.timezone);
});
test('venue plan drafts remove client keys, normalize counts and match the API grammar', () => {
  const checked = validatePlan([section], 0); assert.equal(checked.valid, true); assert.equal(checked.total, 3);
  assert.deepEqual(layoutInput.parse({ expectedRevision: 0, sections: checked.data }).sections, checked.data);
  assert.deepEqual(checked.data, [{ name: 'Main', rows: [{ label: 'A', seats: 3 }] }]);
  assert.deepEqual(previewSections(checked.data)[0].seats.map(seat => seat.number), [1, 2, 3]);
});
test('venue UI rejects duplicate normalized labels, fractional/exponent counts and over-capacity plans', () => {
  for (const plan of [[section, section], [{ name: 'Main', rows: [{ label: 'A', seats: '3' }, { label: ' A ', seats: '2' }] }], [{ name: 'Main', rows: [{ label: 'A', seats: '2.5' }] }], [{ name: 'Main', rows: [{ label: 'A', seats: '1e1' }] }], [{ name: 'Main', rows: Array.from({ length: 13 }, (_, n) => ({ label: String(n), seats: '40' })) }]]) {
    assert.equal(validatePlan(plan).valid, false); assert.deepEqual(previewSections(plan), []);
  }
});
test('saved physical layouts round-trip only when their row numbers are consecutive', () => {
  const saved = [{ id: other, name: 'Main', seats: [{ id, rowLabel: 'A', number: 2 }, { id: other, rowLabel: 'A', number: 1 }] }];
  assert.deepEqual(planFromSaved(saved), [{ name: 'Main', rows: [{ label: 'A', seats: '2' }] }]);
  assert.equal(planFromSaved([{ ...saved[0], seats: [{ id, rowLabel: 'A', number: 1 }, { id: other, rowLabel: 'A', number: 3 }] }]), null);
  assert.equal(planFromSaved([{ ...saved[0], seats: [] }]), null);
});
test('confirmed create/delete handoff clears old data without an unnecessary refresh or replay', async () => {
  let reads = 0, writes = 0;
  const store = createWorkspaceStore({ load: async () => { reads++; return venue; }, write: async () => { writes++; return { id, deleted: true }; } });
  await store.refresh(); assert.deepEqual(await store.mutate('delete', {}, 'Removed.', { refreshAfter: false }), { id, deleted: true });
  assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(store.getSnapshot().page, null); assert.equal(store.getSnapshot().status, 'loading');
  await assert.rejects(store.mutate('delete', {})); assert.equal(writes, 1);
});
test('venue transport checks scope, role, frozen flag and physical IDs before accepting detail', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ ...venue, hasShows: false, sections: [], organization: access });
    assert.equal((await venueRequest('detail', { organizationId: id, venueId: id })).hasShows, false);
    let unexpectedFetches = 0;
    globalThis.fetch = async () => { unexpectedFetches++; return Response.json({}); };
    for (const action of ['__proto__', 'constructor', 'toString']) await assert.rejects(venueRequest(action, { organizationId: id, venueId: id }), error => error.status === 400);
    assert.equal(unexpectedFetches, 0);
    for (const patch of [{ organization: { ...access, id: other } }, { hasShows: undefined }, { sections: [{ id: other, name: 'Main', seats: [{ id, rowLabel: 'A', number: 1 }, { id, rowLabel: 'B', number: 2 }] }] }]) {
      globalThis.fetch = async () => Response.json({ ...venue, hasShows: false, sections: [], organization: access, ...patch });
      await assert.rejects(venueRequest('detail', { organizationId: id, venueId: id }), /confirm/);
    }
  } finally { globalThis.fetch = original; }
});
test('venue mutations carry observed revisions and CSRF, reject mismatched success and sanitize errors', async () => {
  const original = globalThis.fetch; const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push([url, options]); return Response.json({ ...venue, revision: 1, hasShows: false, sections: [{ id: other, name: 'Main', seats: [{ id, rowLabel: 'A', number: 1 }] }] }); };
    await venueRequest('layout', { organizationId: id, venueId: id, body: { expectedRevision: 0, sections: [{ name: 'Main', rows: [{ label: 'A', seats: 1 }] }] }, csrfToken: 'csrf' });
    assert.equal(calls[0][1].method, 'PUT'); assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].headers['X-CSRF-Token'], 'csrf');
    assert.equal(JSON.parse(calls[0][1].body).expectedRevision, 0);
    globalThis.fetch = async () => Response.json({ ...venue, id: other, revision: 1 });
    await assert.rejects(venueRequest('patch', { organizationId: id, venueId: id, body: { expectedRevision: 0 } }), /confirm/);
    globalThis.fetch = async () => Response.json({ error: 'VENUE_STALE' }, { status: 409 });
    await assert.rejects(venueRequest('detail', { organizationId: id, venueId: id }), /Someone changed/);
    globalThis.fetch = async () => Response.json({ error: 'raw secret credentials' }, { status: 500 });
    await assert.rejects(venueRequest('detail', { organizationId: id, venueId: id }), error => !error.message.includes('credentials'));
    for (const code of ['__proto__', 'constructor', { unexpected: 'object' }]) {
      globalThis.fetch = async () => Response.json({ error: code }, { status: 500 });
      await assert.rejects(venueRequest('detail', { organizationId: id, venueId: id }), error => typeof error.message === 'string' && error.message === 'The workspace request could not be completed.');
    }
  } finally { globalThis.fetch = original; }
});
