import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../apps/web/src/auth/session-store.js';
import { AuthError, authRequest } from '../apps/web/src/auth/client.js';

const sample = { user: { id: 'a-user', email: 'test@example.invalid', displayName: 'Reader', role: 'CUSTOMER' }, csrfToken: 'a'.repeat(43), expiresAt: '2030-01-01T00:00:00Z' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('a stale session read cannot resurrect access after logout, even if transport ignores abort', async () => {
  const old = deferred(); let reads = 0;
  const store = createSessionStore(async action => action === 'session' ? (++reads === 1 ? sample : old.promise) : null);
  await store.refresh();
  const stale = store.refresh({ background: true });
  await store.mutate('logout');
  old.resolve(sample); await stale;
  assert.equal(store.getSnapshot().status, 'anonymous');
  assert.equal(store.getSnapshot().session, null);
});

test('network uncertainty hides private data and requires a session read instead of replaying a mutation', async () => {
  let mutations = 0;
  const store = createSessionStore(async action => {
    if (action === 'session') throw new AuthError('AUTH_REQUIRED', 401);
    mutations++; throw new AuthError('CONNECTION_ERROR');
  });
  await store.refresh();
  await assert.rejects(store.mutate('register', { email: 'test@example.invalid' }));
  assert.equal(store.getSnapshot().status, 'error');
  assert.equal(store.getSnapshot().session, null);
  await store.refresh();
  assert.equal(store.getSnapshot().status, 'anonymous');
  assert.equal(mutations, 1);
});

test('pending mutations block duplicate submissions and background reads', async () => {
  const pending = deferred(); const calls = [];
  const store = createSessionStore((action, options) => { calls.push([action, options]); return pending.promise; });
  const first = store.mutate('login', { email: 'test@example.invalid' });
  await store.refresh({ background: true });
  await assert.rejects(store.mutate('login'), { status: 409 });
  assert.equal(calls.length, 1);
  pending.resolve(sample); await first;
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.equal(store.getSnapshot().busy, false);
});

test('logout 401 clears ended access; logout 403 requires recovery without automatic retry', async () => {
  for (const status of [401, 403]) {
    let mutations = 0;
    const store = createSessionStore(async (action, options) => {
      if (action === 'session') return sample;
      mutations++; assert.equal(options.csrfToken, sample.csrfToken);
      throw new AuthError(status === 401 ? 'AUTH_REQUIRED' : 'CSRF_REJECTED', status);
    });
    await store.refresh();
    if (status === 401) await store.mutate('logout');
    else await assert.rejects(store.mutate('logout'));
    assert.equal(store.getSnapshot().status, status === 401 ? 'anonymous' : 'error');
    assert.equal(store.getSnapshot().session, null);
    assert.equal(mutations, 1);
  }
});

test('session-check outages are distinct from a confirmed anonymous response', async () => {
  let failing = false;
  const store = createSessionStore(async () => { if (failing) throw new AuthError('CONNECTION_ERROR'); return sample; });
  await store.refresh(); failing = true;
  await store.refresh({ background: true });
  assert.equal(store.getSnapshot().status, 'error');
  assert.equal(store.getSnapshot().session, null);
});

test('startup recovery hides private data, then restores the session; abandoned retry feedback stays fenced', async () => {
  let recovering, calls = 0;
  const pending = deferred();
  const store = createSessionStore(async (action, options) => {
    if (action !== 'session') return null;
    if (++calls === 1) return sample;
    recovering = options.onRetry; recovering(); return pending.promise;
  });
  await store.refresh(); const read = store.refresh({ background: true });
  assert.equal(store.getSnapshot().status, 'loading'); assert.equal(store.getSnapshot().waking, true);
  assert.equal(store.getSnapshot().session, null);
  pending.resolve(sample); await read;
  assert.equal(store.getSnapshot().status, 'authenticated'); assert.equal(store.getSnapshot().waking, false);
  await store.mutate('logout'); recovering();
  assert.equal(store.getSnapshot().status, 'anonymous'); assert.equal(store.getSnapshot().waking, false);
});

test('the auth client uses same-origin cookies and CSRF, validates success, and never reflects server error text', async t => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url, options }; return new Response(null, { status: 204 });
  });
  await authRequest('logout', { csrfToken: sample.csrfToken });
  assert.equal(captured.url, '/api/auth/logout');
  assert.equal(captured.options.credentials, 'same-origin');
  assert.equal(captured.options.headers['X-CSRF-Token'], sample.csrfToken);
  assert.equal(captured.options.headers.Origin, undefined); // The real browser owns Origin.
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ error: '<script>untrusted text</script>' }, { status: 500 }));
  await assert.rejects(authRequest('login'), error => !error.message.includes('<script>') && error.status === 500);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ user: sample.user }));
  await assert.rejects(authRequest('session'), { code: 'INVALID_RESPONSE' });
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ error: 'AUTH_RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '42' } }));
  await assert.rejects(authRequest('login'), error => error.status === 429 && error.message.includes('42 seconds'));
});
