import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationRequest, validReview, validReceipt, matchesReview, PublicationError } from '../apps/web/src/publication/client.js';
import { createPublicationStore } from '../apps/web/src/publication/store.js';

const org = '10000000-0000-4000-8000-000000000001', eventId = '20000000-0000-4000-8000-000000000001', id = '30000000-0000-4000-8000-000000000001', venueId = '40000000-0000-4000-8000-000000000001';
function fixture() {
  const organization = { id: org, name: 'Team', status: 'APPROVED', role: 'OWNER' };
  const event = { id: eventId, title: 'A programme', category: 'Talks', status: 'DRAFT', publicationRevision: 3 };
  const show = { id, venueId, status: 'SCHEDULED', revision: 1, startsAt: '2030-10-30T13:30:00.123456Z', priceMinor: 75000, currency: 'INR', seatCount: 3 };
  const review = { event, organization, reviewToken: 'a'.repeat(64), inventoryCount: 3, shows: [{ ...show, venue: { id: venueId, name: 'Stage', city: 'Bengaluru', timezone: 'Asia/Kolkata', revision: 2 } }] };
  const receipt = { event: { ...event, status: 'PUBLISHED', publicationRevision: 4, publishedAt: '2026-10-31T00:00:00.123456+00:00' }, inventoryCount: 3, shows: [show] };
  const draft = { event: { ...event, publishedAt: null }, organization, receipt: null };
  const published = { event: { ...receipt.event, publishedAt: '2026-10-31T00:00:00.123Z' }, organization, receipt };
  return { review, receipt, draft, published };
}
test('publication validation checks scope, counts, exact reviewed values and timestamp calendar fields', () => {
  const { review, receipt } = fixture(); assert.ok(validReview(review, org, eventId)); assert.ok(validReceipt(receipt, eventId)); assert.ok(matchesReview(receipt, review));
  for (const update of [{ inventoryCount: 4 }, { shows: [...review.shows, ...review.shows] }, { shows: [] }, { reviewToken: 'A'.repeat(64) }, { event: { ...review.event, id: venueId } }]) assert.equal(Boolean(validReview({ ...review, ...update }, org, eventId)), false);
  for (const update of [{ priceMinor: 1 }, { startsAt: '2030-10-30T13:30:00.123457Z' }, { seatCount: 4 }, { venueId: id }]) assert.equal(Boolean(matchesReview({ ...receipt, shows: [{ ...receipt.shows[0], ...update }] }, review)), false);
  assert.equal(Boolean(validReceipt({ ...receipt, event: { ...receipt.event, publishedAt: '2026-02-30T00:00:00Z' } }, eventId)), false);
  assert.equal(Boolean(matchesReview(receipt, {})), false);
});
test('publication transport sends only the token with CSRF and rejects inconsistent success and inherited errors', async () => {
  const original = globalThis.fetch, { review, receipt, published } = fixture(), options = { organizationId: org, eventId, review, csrfToken: 'fixture-csrf' }; let sent, calls = 0;
  try {
    for (const action of ['__proto__', 'constructor', 'toString']) await assert.rejects(publicationRequest(action, options), { status: 400 });
    globalThis.fetch = async (url, init) => { sent = { url, init }; calls++; return Response.json(receipt); };
    await publicationRequest('publish', options); assert.equal(calls, 1); assert.equal(sent.init.method, 'POST'); assert.equal(sent.init.credentials, 'same-origin'); assert.equal(sent.init.headers['X-CSRF-Token'], 'fixture-csrf'); assert.deepEqual(JSON.parse(sent.init.body), { reviewToken: review.reviewToken });
    globalThis.fetch = async (url, init) => { sent = { url, init }; return Response.json(published); }; await publicationRequest('status', options); assert.ok(sent.url.endsWith('/publication/status')); assert.equal(sent.init.method, 'GET'); assert.equal(sent.init.body, undefined);
    for (const invalid of [{ ...published, event: { ...published.event, publishedAt: null } }, { ...published, organization: { ...published.organization, id: id } }, { ...published, event: { ...published.event, status: 'DRAFT' } }]) { globalThis.fetch = async () => Response.json(invalid); await assert.rejects(publicationRequest('status', options), /confirm/); }
    globalThis.fetch = async () => Response.json({ ...receipt, inventoryCount: 2 }); await assert.rejects(publicationRequest('publish', options), /confirm/);
    for (const code of ['__proto__', 'constructor', { private: 'do not reflect' }]) { globalThis.fetch = async () => Response.json({ error: code }, { status: 500 }); await assert.rejects(publicationRequest('publish', options), error => error.message === 'The workspace request could not be completed.'); }
  } finally { globalThis.fetch = original; }
});
test('preparation/confirmation save nothing; immutable reviewed snapshot and synchronous guard yield one publish', async () => {
  const { review, receipt, draft } = fixture(); let posts = 0, finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const store = createPublicationStore({ readStatus: async () => draft, readReview: async () => review, publish: async snapshot => { posts++; assert.equal(snapshot.shows[0].priceMinor, 75000); return delayed; } });
  await store.load(); await store.prepare(); review.shows[0].priceMinor = 1; assert.equal(store.getSnapshot().review.shows[0].priceMinor, 75000);
  assert.throws(() => { store.getSnapshot().review.shows[0].seatCount = 99; }, TypeError);
  store.confirm(); store.back(); assert.equal(store.getSnapshot().status, 'review'); assert.equal(posts, 0); store.confirm();
  const first = store.save(); await assert.rejects(store.save(), { status: 409 }); assert.equal(posts, 1); finish(receipt); await first; assert.equal(store.getSnapshot().status, 'record');
});
test('lost committed response resolves by GET receipt without repeating POST', async () => {
  const { review, receipt, draft, published } = fixture(); let posts = 0;
  const store = createPublicationStore({ readStatus: async () => posts ? published : draft, readReview: async () => review, publish: async () => { posts++; throw new PublicationError('CONNECTION_ERROR'); } });
  await store.load(); await store.prepare(); store.confirm(); await store.save(); assert.equal(store.getSnapshot().status, 'uncertain'); assert.equal(store.getSnapshot().data, null); assert.equal(store.getSnapshot().review, null);
  await store.load(); assert.equal(store.getSnapshot().status, 'record'); assert.deepEqual(store.getSnapshot().data.receipt, receipt); assert.equal(posts, 1);
});
test('uncertain uncommitted publication permits explicit same-token retry only after a status read', async () => {
  const { review, receipt, draft } = fixture(); const tokens = []; let reads = 0;
  const store = createPublicationStore({ readStatus: async () => { reads++; return draft; }, readReview: async () => review, publish: async snapshot => { tokens.push(snapshot.reviewToken); if (tokens.length === 1) throw new PublicationError('CONNECTION_ERROR'); return receipt; } });
  await store.load(); await store.prepare(); store.confirm(); await store.save(); await assert.rejects(store.save(), { status: 409 }); assert.equal(tokens.length, 1);
  await store.load(); assert.equal(store.getSnapshot().status, 'retry'); assert.equal(tokens.length, 1); await store.save(); assert.deepEqual(tokens, [review.reviewToken, review.reviewToken]); assert.equal(reads, 2); assert.equal(store.getSnapshot().status, 'record');
});
test('stale publication and changed revision or role clear the old intention rather than silently re-reviewing', async () => {
  for (const changed of ['revision', 'role']) {
    const { review, draft } = fixture(); let attempted = false, reviewReads = 0;
    const after = { ...draft, event: { ...draft.event, publicationRevision: changed === 'revision' ? 4 : 3 }, organization: { ...draft.organization, role: changed === 'role' ? 'STAFF' : 'OWNER' } };
    const store = createPublicationStore({ readStatus: async () => attempted ? after : draft, readReview: async () => { reviewReads++; return review; }, publish: async () => { attempted = true; throw new PublicationError('CONNECTION_ERROR'); } });
    await store.load(); await store.prepare(); store.confirm(); await store.save(); await store.load(); assert.equal(store.getSnapshot().status, 'draft'); assert.equal(store.getSnapshot().review, null); assert.equal(reviewReads, 1); await assert.rejects(store.save(), { status: 409 });
  }
  const { review, draft } = fixture(); const stale = createPublicationStore({ readStatus: async () => draft, readReview: async () => review, publish: async () => { throw new PublicationError('PUBLICATION_STALE', 409); } });
  await stale.load(); await stale.prepare(); stale.confirm(); await stale.save(); assert.equal(stale.getSnapshot().status, 'error'); await stale.load(); assert.equal(stale.getSnapshot().status, 'draft');
});
test('failed recovery reads hide private data and retain only same-scope uncertain intention; discard sends no write', async () => {
  const { review, draft } = fixture(); let reads = 0, posts = 0;
  const store = createPublicationStore({ readStatus: async () => { if (++reads === 2) throw new PublicationError('ACCESS_BUSY', 503); return draft; }, readReview: async () => review, publish: async () => { posts++; throw new PublicationError('CONNECTION_ERROR'); } });
  await store.load(); await store.prepare(); store.confirm(); await store.save(); await store.load(); assert.equal(store.getSnapshot().status, 'uncertain'); assert.equal(store.getSnapshot().review, null); assert.equal(store.getSnapshot().data, null);
  await store.load(); assert.equal(store.getSnapshot().status, 'retry'); store.discard(); assert.equal(store.getSnapshot().status, 'draft'); assert.equal(store.getSnapshot().review, null); assert.equal(posts, 1);
});
test('scope disposal ignores late reads/writes and never resurrects private review or triggers old auth recovery', async () => {
  const { review, receipt, draft } = fixture(); let finish, recoveries = 0;
  const delayed = new Promise(resolve => { finish = resolve; });
  const store = createPublicationStore({ readStatus: async () => draft, readReview: async () => review, publish: async () => delayed, onAuthRequired: () => { recoveries++; } });
  await store.load(); await store.prepare(); store.confirm(); const save = store.save(); store.cancel(); const before = store.getSnapshot(); finish(receipt); await save; assert.equal(store.getSnapshot(), before); assert.equal(recoveries, 0);
  let endRead; const late = createPublicationStore({ readStatus: () => new Promise((resolve, reject) => { endRead = reject; }), readReview: async () => review, publish: async () => receipt, onAuthRequired: () => { recoveries++; } });
  const reading = late.load(); late.cancel(); endRead(new PublicationError('AUTH_REQUIRED', 401)); await reading; assert.equal(recoveries, 0);
});
test('staff review cannot enter confirmation and fresh published/legacy/cancelled loads never publish', async () => {
  const { review, draft, published } = fixture(); let posts = 0;
  const staff = { ...review, organization: { ...review.organization, role: 'STAFF' } };
  const store = createPublicationStore({ readStatus: async () => ({ ...draft, organization: staff.organization }), readReview: async () => staff, publish: async () => { posts++; } });
  await store.load(); await store.prepare(); store.confirm(); assert.equal(store.getSnapshot().status, 'review'); await assert.rejects(store.save(), { status: 409 });
  for (const data of [published, { ...published, event: { ...published.event, publishedAt: null }, receipt: null }, { ...published, event: { ...published.event, status: 'CANCELLED' } }]) {
    const current = createPublicationStore({ readStatus: async () => data, readReview: async () => review, publish: async () => { posts++; } }); await current.load(); assert.equal(current.getSnapshot().status, 'record'); await current.prepare(); await assert.rejects(current.save(), { status: 409 });
  }
  assert.equal(posts, 0);
});
