import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { evidenceFixture } from '../../scripts/lib/evidence-fixture.js';
import { bookingModel, functionCall, reply } from '../helpers/assistant-model.js';
import { createToolExecutor, initialContext } from '../../apps/api/src/assistant/tools.js';
import { readReservation } from '../../apps/api/src/reservations/service.js';
import { nullablePreferences } from '../helpers/assistant-model.js';
import { createLanguageModel } from '../../apps/api/src/assistant/model.js';

const options = model => ({ apiCount: 2, assistantModel: model, assistantConfig: { AI_ASSISTANT_ENABLED: true } });
async function json(response, status = 200) { const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; }
async function conversation(c, who) { return json(await c.request(who, '/api/assistant/conversations', { method: 'POST', body: {} }), 201); }
async function turn(c, who, state, message, extra = {}) { return c.request(who, `/api/assistant/conversations/${state.id}/messages`, { method: 'POST', body: { message, revision: state.revision }, ...extra }); }
async function catalogue(c, title = 'Comedy evening') {
  const f = await c.catalogue(title); await c.addSeats(f, 3);
  await c.pool.query("UPDATE venues SET city='Bengaluru' WHERE id=$1", [f.venue]);
  await c.pool.query("UPDATE events SET category='Comedy' WHERE id=$1", [f.event]); return f;
}
async function proposal(c, who) {
  let state = await conversation(c, who);
  state = await json(await turn(c, who, state, 'Find comedy in Bangalore, two seats under 1500'));
  state = await json(await turn(c, who, state, 'Recommend seats for event 1'));
  state = await json(await turn(c, who, state, 'Book these seats'));
  assert.ok(state.proposal); return state;
}
const confirmation = state => ({ method: 'POST', body: { proposalId: state.proposal.id, revision: state.revision, confirmed: true } });

test('assistant search, conversation context, explicit confirmation and duplicate holds across two APIs', async () => {
  let calls = 0;
  await evidenceFixture(async c => {
    const who = await c.actor(), stranger = await c.actor(), f = await catalogue(c);
    let state = await conversation(c, who), id = state.id;
    assert.equal((await fetch(c.origins[0] + '/api/assistant/status')).status, 401);
    assert.equal((await c.request(stranger, '/api/assistant/conversations/' + id)).status, 404);
    const key = randomUUID(), body = { message: 'Find comedy in Bangalore, two seats under 1500', revision: state.revision };
    state = await json(await turn(c, who, state, body.message, { key }));
    assert.equal(state.preferences.city, 'Bangalore'); assert.equal(state.preferences.ticketCount, 2);
    assert.equal(state.messages.at(-1).cards[0].title, f.title);
    const before = calls;
    await json(await c.request(who, `/api/assistant/conversations/${id}/messages`, { method: 'POST', body, key, api: 1 }));
    assert.equal(calls, before, 'Completed request must not call model again');
    assert.equal((await c.request(who, `/api/assistant/conversations/${id}/messages`, { method: 'POST', body: { ...body, message: 'different' }, key })).status, 409);
    state = await json(await turn(c, who, state, 'Show cheaper options'));
    assert.equal(state.preferences.category, 'Comedy'); assert.equal(state.preferences.city, 'Bangalore'); assert.equal(state.preferences.budgetMinor, 100000);
    // A fresh conversation keeps its own filters and produces an affordable proposal.
    state = await proposal(c, who);
    const path = `/api/assistant/conversations/${state.id}/confirm-hold`;
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 0);
    assert.equal((await c.request(who, path, { method: 'POST', body: { proposalId: state.proposal.id, revision: state.revision } })).status, 400);
    assert.equal((await c.request(who, path, { ...confirmation(state), body: { ...confirmation(state).body, totalMinor: 1 } })).status, 400);
    assert.equal((await c.request(stranger, path, confirmation(state))).status, 404);
    assert.equal((await c.request({ ...who, csrf: 'bad' }, path, confirmation(state))).status, 403);
    const holds = await Promise.all([c.request(who, path, confirmation(state)), c.request(who, path, { ...confirmation(state), api: 1 })]);
    const first = await json(holds[0], 201), second = await json(holds[1], 201);
    assert.equal(first.hold.id, second.hold.id); assert.equal(first.hold.totalMinor, 150000);
    assert.equal(Date.parse(first.hold.expiresAt) - Date.parse(first.hold.createdAt), 300000);
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 1);
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM payment_attempts')).rows[0].n, 0);
    assert.equal((await c.request(stranger, `/api/reservations/${first.hold.id}`)).status, 404);
    assert.match(first.hold.checkoutPath, new RegExp(`/events/${f.event}/shows/${f.show}/checkout/`));
    const status = await json(await turn(c, who, first, 'Check booking status'));
    assert.equal(status.messages.at(-1).cards[0].effectiveStatus, 'ACTIVE');
  }, options(bookingModel({ inspect: () => calls++ })));
});

test('assistant rejects stale quotes, changed prices and unavailable seats without partial holds', async () => {
  await evidenceFixture(async c => {
    const who = await c.actor(), other = await c.actor(), f = await catalogue(c);
    let state = await proposal(c, who), path = `/api/assistant/conversations/${state.id}/confirm-hold`;
    await c.pool.query("UPDATE assistant_conversations SET context=jsonb_set(context,'{proposal,expiresAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1", [state.id]);
    assert.equal((await c.request(who, path, confirmation(state))).status, 409);
    state = await proposal(c, who); path = `/api/assistant/conversations/${state.id}/confirm-hold`;
    await c.pool.query('UPDATE show_seats SET price_minor=80000 WHERE show_id=$1', [f.show]);
    const changed = await json(await c.request(who, path, confirmation(state)), 409); assert.equal(changed.error, 'QUOTE_CHANGED');
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 0);
    await c.pool.query('UPDATE show_seats SET price_minor=75000 WHERE show_id=$1', [f.show]);
    const taken = await json(await c.request(other, '/api/reservations', { method: 'POST', body: { showId: f.show, seatIds: state.proposal.seats.map(seat => seat.id) } }), 201);
    assert.ok(taken.id);
    assert.equal((await json(await c.request(who, path, confirmation(state)), 409)).error, 'SEATS_UNAVAILABLE');
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n, 1);
  }, options(bookingModel()));
});

test('assistant failures are sanitized, retry same command, isolate users and enforce shared rate budgets', async () => {
  let fail = true;
  await evidenceFixture(async c => {
    const who = await c.actor(), other = await c.actor(), state = await conversation(c, who), key = randomUUID();
    const failed = await json(await turn(c, who, state, 'Hello', { key }), 503);
    assert.equal(failed.error, 'AI_UNAVAILABLE'); assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
    const read = await json(await c.request(who, '/api/assistant/conversations/' + state.id, { api: 1 }));
    assert.equal(read.busy, false); assert.equal(read.pending.status, 'FAILED'); assert.equal(read.revision, 0);
    fail = false;
    const recovered = await json(await turn(c, who, state, 'Hello', { key, api: 1 })); assert.equal(recovered.revision, 1);
    assert.equal(recovered.pending, null);
    const limited = await json(await turn(c, who, recovered, 'Hello again'), 429); assert.equal(limited.error, 'AI_RATE_LIMITED');
    const otherState = await conversation(c, other); assert.equal(otherState.messages.length, 1);
    await json(await turn(c, other, otherState, 'Hello'));
    assert.equal((await c.request(other, '/api/assistant/conversations/' + state.id)).status, 404);
  }, { ...options(async () => { if (fail) throw new Error('PRIVATE_PROVIDER_SECRET'); return reply('What city?'); }),
    assistantConfig: { AI_ASSISTANT_ENABLED: true, AI_USER_TURNS_PER_HOUR: 2 } });
});

test('assistant busy leases prevent parallel model calls and logout fences completion', async () => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  await evidenceFixture(async c => {
    const who = await c.actor(), state = await conversation(c, who);
    const pending = turn(c, who, state, 'Hello'); await started;
    assert.equal((await turn(c, who, state, 'Another request', { api: 1 })).status, 409);
    const read = await json(await c.request(who, '/api/assistant/conversations/' + state.id)); assert.equal(read.busy, true);
    await c.pool.query('DELETE FROM sessions WHERE user_id=$1', [who.id]); release();
    assert.equal((await pending).status, 401);
    assert.equal((await c.pool.query('SELECT revision FROM assistant_conversations WHERE id=$1', [state.id])).rows[0].revision, 0);
  }, options(async () => { entered(); await gate; return reply('What city?'); }));
});

test('disabled assistant does not require credentials or disturb the normal reservation API', async () => {
  await evidenceFixture(async c => {
    const who = await c.actor(), f = await c.catalogue();
    assert.equal((await json(await c.request(who, '/api/assistant/status'))).enabled, false);
    assert.equal((await c.request(who, '/api/assistant/conversations', { method: 'POST', body: {} })).status, 503);
    await json(await c.request(who, '/api/reservations', { method: 'POST', body: { showId: f.show, seatIds: [f.seat] } }), 201);
  });
});

test('tool execution deduplicates reads and rejects foreign booking IDs and invented option references', async () => {
  await evidenceFixture(async c => {
    const who = await c.actor(), other = await c.actor(), f = await catalogue(c); let queries = 0;
    const state = initialContext(), executor = createToolExecutor({ state, pool: { query: (...args) => { queries++; return c.pool.query(...args); } },
      authorize: work => c.tx(db => work(db, { user: { id: who.id } })) });
    const args = { ...nullablePreferences(), city: 'Bangalore', category: 'Comedy', ticketCount: 2 };
    const one = await executor.execute('searchEvents', args), before = queries;
    assert.deepEqual(await executor.execute('searchEvents', args), one); assert.equal(queries, before);
    assert.equal(executor.cards.length, 1);
    await assert.rejects(executor.execute('createSeatHold', { optionRef: randomUUID() }), error => error.code === 'STALE_RECOMMENDATION');
    await assert.rejects(executor.execute('recommendSeats', { offerRef: one.offers[0].offerRef, ticketCount: 2, adjacent: true, preference: null, seatIds: [f.seat] }), error => error.code === 'INVALID_REQUEST');
    const taken = await json(await c.request(other, '/api/reservations', { method: 'POST', body: { showId: f.show, seatIds: [f.seat] } }), 201);
    await assert.rejects(executor.execute('getBookingStatus', { reservationId: taken.id }), error => error.code === 'NOT_FOUND');
  });
});

test('expired holds remain expired in conversation reads and cannot be extended by replaying confirmation', async () => {
  await evidenceFixture(async c => {
    const who = await c.actor(), f = await catalogue(c), state = await conversation(c, who), proposalId = randomUUID();
    const expired = await c.tx(async db => {
      const r = (await db.query(`WITH stamp AS MATERIALIZED(SELECT clock_timestamp()-interval '6 minutes' AS at)
        INSERT INTO reservations(user_id,show_id,total_minor,currency,created_at,expires_at)
        SELECT $1,$2,75000,'INR',at,at+interval '5 minutes' FROM stamp RETURNING id`, [who.id,f.show])).rows[0];
      await db.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES($1,$2,$3,75000,'INR')", [r.id,f.show,f.seat]);
      await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [r.id]);
      await db.query("UPDATE show_seats s SET state='HELD',reservation_id=r.id,expires_at=r.expires_at FROM reservations r WHERE r.id=$1 AND s.show_id=$2 AND s.venue_seat_id=$3", [r.id,f.show,f.seat]);
      return readReservation(db,who.id,r.id);
    });
    const hold = { ...expired, proposalId, eventId: f.event, title: f.title, checkoutPath: `/events/${f.event}/shows/${f.show}/checkout/${expired.id}` };
    await c.pool.query("UPDATE assistant_conversations SET context=jsonb_set(context,'{hold}',$2::jsonb) WHERE id=$1", [state.id,JSON.stringify(hold)]);
    const read = await json(await c.request(who, '/api/assistant/conversations/' + state.id)); assert.equal(read.hold.effectiveStatus, 'EXPIRED');
    const replay = await json(await c.request(who, `/api/assistant/conversations/${state.id}/confirm-hold`, { method: 'POST', body: { proposalId, revision: 0, confirmed: true } }), 201);
    assert.equal(replay.hold.expiresAt, expired.expiresAt); assert.equal(replay.hold.effectiveStatus, 'EXPIRED');
    assert.equal((await c.request(who, `/api/reservations/${expired.id}/payment-attempts`, { method: 'POST', body: {} })).status, 409);
  }, options(bookingModel()));
});

test('expired processing leases recover on another API and fence a late old completion', async () => {
  let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  await evidenceFixture(async c => {
    const who = await c.actor(), state = await conversation(c, who), key = randomUUID();
    const pending = turn(c, who, state, 'Hello', { key }); await started;
    await c.pool.query("UPDATE assistant_conversations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [state.id]);
    const recovered = await json(await turn(c, who, state, 'Hello', { key, api: 1 })); assert.equal(recovered.revision, 1);
    release(); assert.equal((await pending).status, 409);
    const final = await json(await c.request(who, '/api/assistant/conversations/' + state.id));
    assert.equal(final.revision, 1); assert.equal(final.messages.filter(message => message.role === 'user').length, 1);
  }, options(async () => { if (++calls === 1) { entered(); await gate; } return reply('What city?'); }));
});

test('native Gemini HTTP contract drives the authenticated chat and existing hold command', async () => {
  const scripted = bookingModel(), requests = [];
  const model = createLanguageModel({ GEMINI_API_KEY: 'mock-gemini-private-key' }, { fetchImpl: async (url, options) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    assert.equal(options.headers['x-goog-api-key'], 'mock-gemini-private-key');
    const body = JSON.parse(options.body); requests.push(body);
    let parts;
    if (body.contents.at(-1).parts[0].functionResponse) parts = [{ text: 'Ready.' }];
    else {
      const result = await scripted({ messages: [{ role: 'system', content: body.systemInstruction.parts[0].text },
        { role: 'user', content: body.contents.at(-1).parts[0].text }] });
      const call = result.tool_calls[0].function;
      parts = [{ functionCall: { id: 'native-' + requests.length, name: call.name, args: JSON.parse(call.arguments) }, thoughtSignature: 'opaque-signature' }];
    }
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] });
  } });
  await evidenceFixture(async c => {
    const who = await c.actor(); await catalogue(c); const state = await proposal(c, who);
    assert.equal(requests.length, 6); assert.ok(!JSON.stringify(state).includes('opaque-signature'));
    assert.ok(!JSON.stringify(state).includes('mock-gemini-private-key'));
    const held = await json(await c.request(who, `/api/assistant/conversations/${state.id}/confirm-hold`, confirmation(state)), 201);
    assert.equal(held.hold.totalMinor, 150000); assert.equal(held.hold.items.length, 2);
    assert.equal(requests.length, 6, 'Confirmation never calls either AI provider');
    assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM payment_attempts')).rows[0].n, 0);
  }, options(model));
});

test('Gemini default cannot accidentally enable the assistant with only an OpenAI key', async () => {
  await evidenceFixture(async c => {
    const who = await c.actor();
    assert.equal((await json(await c.request(who, '/api/assistant/status'))).enabled, false);
    assert.equal((await c.request(who, '/api/assistant/conversations', { method: 'POST', body: {} })).status, 503);
  }, { assistantConfig: { AI_ASSISTANT_ENABLED: true, OPENAI_API_KEY: 'unused-openai-private-key' } });
});
