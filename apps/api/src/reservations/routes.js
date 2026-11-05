import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { browserMutation, sessionCookie, verifyCsrf } from '../auth/security.js';
import { claimIdempotency, completeIdempotency } from '../reliability/idempotency.js';
import { HttpError } from '../http-error.js';
import { createReservation, readReservation, releaseReservation } from './service.js';
import { readCurrentReservations } from './recovery.js';
import { reservationCommand, reservationId, reservationRecoveryQuery, parseReservationValue as parse } from './commands.js';
export function createReservationRouter({ pool, config }) {
  const router = Router(), boundary = browserMutation(config);
  router.use('/reservations', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const run = (operation, work, querySchema = z.object({}).strict(), closeOnly = false) => async (req, res) => {
    const result = await withAuthorizedSession(pool, config, sessionCookie(req, config), async (db, session) => {
      const query = parse(querySchema, req.query);
      if (!operation) return { status: 200, body: await work(db, session.user.id, req, query) };
      verifyCsrf(req, session);
      const { input, body } = reservationCommand(operation, session.user.id, req.get('Idempotency-Key'), req.body, req.params.id);
      const claim = await claimIdempotency(db, input);
      if (claim.kind === 'conflict') throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
      if (claim.kind === 'replay') return { status: claim.status, body: claim.body };
      if (closeOnly) {
        // Same user/operation/key/hash as the original command. This receipt
        // fences a late sender WITHOUT taking inventory or releasing a hold.
        const body = { error: 'REQUEST_CLOSED', operation: input.operation, requestKey: input.key, paymentMode: 'simulated' };
        await completeIdempotency(db, input, 409, body);
        return { status: 409, body };
      }
      const saved = operation === 'reservation.create' ? await createReservation(db, session.user.id, body) : await releaseReservation(db, session.user.id, body.id);
      const status = operation === 'reservation.create' ? 201 : 200;
      await completeIdempotency(db, input, status, saved);
      return { status, body: saved };
    });
    res.status(result.status).json(result.body); // Includes deferred constraints/COMMIT.
  };
  const closeRequest = operation => run(operation, null, undefined, true);
  router.post('/reservations', boundary, run('reservation.create'));
  router.post('/reservations/resolve-create', boundary, closeRequest('reservation.create'));
  // Literal route must precede /:id so "current" is not parsed as a UUID.
  router.get('/reservations/current', run(null, (db, userId, req, query) => readCurrentReservations(db, userId, query), reservationRecoveryQuery));
  router.get('/reservations/:id', run(null, (db, userId, req) => readReservation(db, userId, parse(reservationId, req.params.id, true))));
  router.post('/reservations/:id/release', boundary, run('reservation.release'));
  router.post('/reservations/:id/resolve-release', boundary, closeRequest('reservation.release'));
  return router;
}
