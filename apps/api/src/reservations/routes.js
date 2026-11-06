import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { browserMutation, sessionCookie, verifyCsrf } from '../auth/security.js';
import { readReservation } from './service.js';
import { executeReservationCommand } from './command-service.js';
import { readCurrentReservations } from './recovery.js';
import { reservationId, reservationRecoveryQuery, parseReservationValue as parse } from './commands.js';
export function createReservationRouter({ pool, config }) {
  const router = Router(), boundary = browserMutation(config);
  router.use('/reservations', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const run = (operation, work, querySchema = z.object({}).strict(), closeOnly = false) => async (req, res) => {
    const result = await withAuthorizedSession(pool, config, sessionCookie(req, config), async (db, session) => {
      const query = parse(querySchema, req.query);
      if (!operation) return { status: 200, body: await work(db, session.user.id, req, query) };
      verifyCsrf(req, session);
      return executeReservationCommand(db, session.user.id, operation, req.get('Idempotency-Key'), req.body, { id: req.params.id, closeOnly });
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
