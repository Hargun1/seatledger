import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAssistantStore } from '../apps/web/src/assistant/store.js';
import { AssistantError, assistantRequest, validConversation } from '../apps/web/src/assistant/client.js';
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), values }; };
const conversation = () => ({ id: randomUUID(), revision: 0, messages: [{ id: randomUUID(), role: 'assistant', text: 'Hello', cards: [] }],
  busy: false, proposal: null, hold: null, pending: null, serverNow: '2026-11-06T12:00:00Z', expiresAt: '2026-11-07T12:00:00Z', paymentMode: 'simulated' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('assistant client keeps credentials same-origin, sends CSRF and validates conversation identity', async () => {
  const value = conversation(), key = randomUUID(); let received;
  assert.ok(validConversation(value));
  await assistantRequest('message', { id: value.id, key, csrfToken: 'a'.repeat(43), body: { message: 'Hello', revision: 0 },
    fetchImpl: async (url, options) => { received = { url, ...options }; return Response.json(value); } });
  assert.equal(received.url, `/api/assistant/conversations/${value.id}/messages`); assert.equal(received.credentials, 'same-origin');
  assert.equal(received.headers['X-CSRF-Token'], 'a'.repeat(43)); assert.equal(received.headers['Idempotency-Key'], key);
  await assert.rejects(assistantRequest('read', { id: randomUUID(), fetchImpl: async () => Response.json(value) }), error => error.code === 'UNKNOWN');
  await assert.rejects(assistantRequest('read', { id: value.id, fetchImpl: async () => Response.json({ error: 'PRIVATE_INTERNAL' }, { status: 500 }) }), error => !error.message.includes('PRIVATE'));
  assert.equal(validConversation({ ...value, messages: [{ ...value.messages[0], cards: [{ type: 'event', eventPath: 'https://evil.invalid' }] }] }), false);
});
test('assistant journal fences double sends and lost responses require GET before explicit retry with original key', async () => {
  const saved = storage(), userId = randomUUID(), value = conversation(), pending = deferred(), calls = [];
  let fail = true;
  const request = async (action, options) => {
    calls.push({ action, options });
    if (action === 'status') return { enabled: true };
    if (action === 'create' || action === 'read') return value;
    if (fail) { await pending.promise; throw new AssistantError('UNKNOWN', 0, true); }
    return { ...value, revision: 1 };
  };
  const store = createAssistantStore({ userId, csrfToken: 'a'.repeat(43), storage: saved, request }); await store.open();
  const first = store.send('Find comedy'); await store.send('duplicate'); pending.resolve(); await first;
  assert.equal(calls.filter(call => call.action === 'message').length, 1);
  await store.retry(); assert.equal(calls.filter(call => call.action === 'message').length, 1);
  await store.refresh(); fail = false; await store.retry();
  const commands = calls.filter(call => call.action === 'message'); assert.equal(commands.length, 2);
  assert.equal(commands[0].options.key, commands[1].options.key); assert.deepEqual(commands[0].options.body, commands[1].options.body);
  assert.equal(store.getSnapshot().pending, null); assert.equal(store.getSnapshot().conversation.revision, 1);
  assert.ok(!JSON.stringify([...saved.values.values()]).includes('Find comedy'), 'Resolved draft is removed');
});
test('assistant reload checks unresolved requests by read and account journals stay isolated', async () => {
  const saved = storage(), userId = randomUUID(), value = conversation(); let posts = 0;
  const request = async action => {
    if (action === 'status') return { enabled: true };
    if (action === 'create' || action === 'read') return value;
    posts++; throw new AssistantError('UNKNOWN', 0, true);
  };
  const first = createAssistantStore({ userId, storage: saved, csrfToken: 'a'.repeat(43), request }); await first.open(); await first.send('PRIVATE DRAFT');
  const restored = createAssistantStore({ userId, storage: saved, csrfToken: 'a'.repeat(43), request }); await restored.open();
  assert.equal(posts, 1); assert.equal(restored.getSnapshot().pending.body.message, 'PRIVATE DRAFT');
  const stranger = createAssistantStore({ userId: randomUUID(), storage: saved, csrfToken: 'b'.repeat(43), request }); await stranger.open();
  assert.equal(stranger.getSnapshot().pending, null);
});
test('assistant storage failure prevents writes and late responses cannot repaint cancelled sessions', async () => {
  let writes = 0;
  const blocked = createAssistantStore({ userId: randomUUID(), storage: { getItem: () => null, setItem: () => { throw new Error('storage'); } },
    request: async () => { writes++; } });
  await blocked.open(); assert.equal(writes, 0); assert.equal(blocked.getSnapshot().error.code, 'STORAGE_UNAVAILABLE');
  const gate = deferred(), value = conversation();
  const store = createAssistantStore({ userId: randomUUID(), storage: storage(), request: async action => action === 'status' ? { enabled: true } : gate.promise });
  const opening = store.open(); await Promise.resolve(); store.cancel(); gate.resolve(value); await opening;
  assert.equal(store.getSnapshot().conversation, null);
});
test('assistant remount recovers an abandoned initial read without duplicate conversation creation', async () => {
  const gate = deferred(), value = conversation(), saved = storage(), keys = [];
  const store = createAssistantStore({ userId: randomUUID(), storage: saved, request: async (action, input) => {
    if (action === 'status') return { enabled: true }; keys.push(input.key); if (keys.length === 1) return gate.promise; return value;
  } });
  const first = store.open(); await Promise.resolve(); await Promise.resolve(); store.cancel(); store.open(); gate.resolve(value); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().conversation.id, value.id); assert.equal(keys[0], keys[1]);
});
