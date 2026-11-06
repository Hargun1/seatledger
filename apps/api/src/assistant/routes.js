import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { browserMutation, sessionCookie, verifyCsrf } from '../auth/security.js';
import { HttpError } from '../http-error.js';
import { executeReservationCommand } from '../reservations/command-service.js';
import { readReservation } from '../reservations/service.js';
import { publicSeats } from '../discovery/service.js';
import { createLanguageModel, providerKey } from './model.js';
import { runAgent } from './agent.js';
import { createConversation, ownedConversation, snapshot, claimTurn, completeTurn, failTurn } from './conversations.js';
import { uuid, empty, messageSchema, confirmationSchema, parse } from './schemas.js';

export function createAssistantRouter({ pool, config, model }) {
  const router = Router(), boundary = browserMutation(config);
  const enabled = Boolean(config.AI_ASSISTANT_ENABLED && (model || providerKey(config)));
  const llm = model || createLanguageModel(config);
  const auth = (req, work, options) => withAuthorizedSession(pool, config, sessionCookie(req, config), work, options);
  const available = () => { if (!enabled) throw new HttpError(503, 'ASSISTANT_UNAVAILABLE'); };
  router.use('/assistant', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/assistant/status', async (req, res) => {
    await auth(req, async () => parse(empty, req.query));
    res.json({ enabled, maxTickets: 8, timezone: 'Asia/Kolkata', paymentMode: 'simulated' });
  });
  router.post('/assistant/conversations', boundary, async (req, res) => {
    const value = await auth(req, async (db, session) => {
      verifyCsrf(req, session); available(); parse(empty, req.query); parse(empty, req.body);
      return createConversation(db, session.user.id, parse(uuid, req.get('Idempotency-Key')), config);
    }, { exclusiveActor: true });
    res.status(201).json(value);
  });
  router.get('/assistant/conversations/:id', async (req, res) => {
    const value = await auth(req, async (db, session) => {
      available(); parse(empty, req.query);
      return snapshot(db, session.user.id, await ownedConversation(db, session.user.id, parse(uuid, req.params.id, true)));
    });
    res.json(value);
  });
  router.post('/assistant/conversations/:id/messages', boundary, async (req, res) => {
    let claim;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    try {
      claim = await auth(req, async (db, session) => {
        verifyCsrf(req, session); available(); parse(empty, req.query);
        return claimTurn(db, session.user.id, parse(uuid, req.params.id, true),
          parse(uuid, req.get('Idempotency-Key')), parse(messageSchema, req.body), config);
      });
      if (claim.replay) return res.json(claim.replay);
      res.on('close', disconnect);
      // No checked-out connection or database transaction spans an LLM call.
      const result = await runAgent({ pool, state: claim.state, history: claim.history, message: claim.message,
        model: llm, authorize: work => auth(req, work), signal: controller.signal });
      const value = await auth(req, async (db, session) => { verifyCsrf(req, session); return completeTurn(db, session.user.id, claim, result); });
      res.json(value);
    } catch (error) {
      if (claim && !claim.replay) await failTurn(pool, claim).catch(() => {});
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'AI_UNAVAILABLE');
    } finally { res.off('close', disconnect); }
  });
  router.post('/assistant/conversations/:id/confirm-hold', boundary, async (req, res) => {
    const value = await auth(req, async (db, session) => {
      verifyCsrf(req, session); available(); parse(empty, req.query);
      const input = parse(confirmationSchema, req.body), userId = session.user.id;
      const row = await ownedConversation(db, userId, parse(uuid, req.params.id, true), true);
      if (row.context.hold?.proposalId === input.proposalId) return snapshot(db, userId, row);
      if (row.busy) throw new HttpError(409, 'ASSISTANT_BUSY');
      const proposal = row.context.proposal;
      if (input.revision !== row.revision || proposal?.id !== input.proposalId) throw new HttpError(409, 'STALE_RECOMMENDATION');
      const fresh = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
      if (new Date(proposal.expiresAt) <= fresh) throw new HttpError(409, 'QUOTE_EXPIRED');
      if (row.context.hold && (await readReservation(db, userId, row.context.hold.id)).effectiveStatus === 'ACTIVE')
        throw new HttpError(409, 'ACTIVE_HOLD_EXISTS');
      const result = await executeReservationCommand(db, userId, 'reservation.create', 'ai-' + proposal.id,
        { showId: proposal.showId, seatIds: proposal.seats.map(seat => seat.id) }, {
          validateSaved: async saved => {
            if (!(await db.query('SELECT clock_timestamp()<$1::timestamptz AS valid', [proposal.expiresAt])).rows[0].valid)
              throw new HttpError(409, 'QUOTE_EXPIRED');
            if (saved.totalMinor !== proposal.totalMinor || saved.currency !== proposal.currency
              || saved.items.length !== proposal.seats.length || saved.items.some(item => !proposal.seats.some(seat =>
                seat.id === item.id && seat.priceMinor === item.priceMinor && seat.currency === item.currency)))
              throw new HttpError(409, 'QUOTE_CHANGED');
            const map = await publicSeats(db, proposal.eventId, proposal.showId);
            if (map.event.title !== proposal.title || new Date(map.show.startsAt).toISOString() !== proposal.startsAt
              || map.show.venue.name !== proposal.venue || map.show.venue.city !== proposal.city || map.show.venue.timezone !== proposal.timezone)
              throw new HttpError(409, 'QUOTE_CHANGED');
          }
        });
      if (result.status >= 300) throw new HttpError(409, 'REQUEST_CLOSED');
      const hold = { ...result.body, proposalId: proposal.id, eventId: proposal.eventId, title: proposal.title,
        checkoutPath: `/events/${proposal.eventId}/shows/${proposal.showId}/checkout/${result.body.id}` };
      const messages = [...row.messages, { id: randomUUID(), role: 'assistant',
        text: 'Your five-minute hold is saved. Continue to simulated checkout to authorize payment yourself.', cards: [{ type: 'hold', ...hold }] }];
      await db.query('UPDATE assistant_conversations SET context=$2::jsonb,messages=$3::jsonb,revision=revision+1 WHERE id=$1',
        [row.id, JSON.stringify({ ...row.context, hold }), JSON.stringify(messages)]);
      return snapshot(db, userId, await ownedConversation(db, userId, row.id));
    });
    res.status(201).json(value);
  });
  return router;
}
