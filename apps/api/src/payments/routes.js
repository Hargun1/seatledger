import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { browserMutation, sessionCookie, verifyCsrf } from '../auth/security.js';
import { claimIdempotency, completeIdempotency } from '../reliability/idempotency.js';
import { HttpError } from '../http-error.js';
import { reservationId, parseReservationValue as parse } from '../reservations/commands.js';
import { paymentCommand, paymentPageQuery } from './commands.js';
import { createPayment, readPayment, listPayments } from './service.js';
import { readRefundStatus } from './refund-status.js';
import { listCustomerPayments } from './history.js';

export function createPaymentRouter({ pool, config }) {
  const router = Router(), boundary = browserMutation(config), empty = z.object({}).strict();
  router.use(['/payments', '/reservations'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const mutate = (closeOnly = false) => async (req, res) => {
    const result = await withAuthorizedSession(pool, config, sessionCookie(req, config), async (db, session) => {
      parse(empty, req.query); verifyCsrf(req, session);
      const { input, body } = paymentCommand(session.user.id, req.get('Idempotency-Key'), req.body, req.params.id);
      const claim = await claimIdempotency(db, input);
      if (claim.kind === 'conflict') throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
      if (claim.kind === 'replay') return { status: claim.status, body: claim.body };
      if (closeOnly) {
        const receipt = { error: 'REQUEST_CLOSED', operation: input.operation, requestKey: input.key, paymentMode: 'simulated' };
        await completeIdempotency(db, input, 409, receipt); return { status: 409, body: receipt };
      }
      const { created, payment } = await createPayment(db, session.user.id, body.reservationId);
      const status = created ? 201 : 200;
      await completeIdempotency(db, input, status, payment); return { status, body: payment };
    });
    res.status(result.status).json(result.body);
  };
  router.post('/reservations/:id/payment-attempts', boundary, mutate());
  router.post('/reservations/:id/resolve-payment', boundary, mutate(true));
  router.get('/payments', async (req, res) => {
    const body = await withAuthorizedSession(pool, config, sessionCookie(req, config), (db, session) => {
      const { cursor } = parse(z.object({ cursor: z.string().max(512).optional() }).strict(), req.query);
      return listCustomerPayments(db, session.user.id, cursor);
    });
    res.json(body);
  });
  router.get('/payments/:id', async (req, res) => {
    const body = await withAuthorizedSession(pool, config, sessionCookie(req, config), (db, session) => {
      parse(empty, req.query); return readPayment(db, session.user.id, parse(reservationId, req.params.id, true));
    });
    res.json(body);
  });
  router.get('/payments/:id/refund', async (req, res) => {
    const body = await withAuthorizedSession(pool, config, sessionCookie(req, config), (db, session) => {
      parse(empty, req.query);
      return readRefundStatus(db, session.user.id, parse(reservationId, req.params.id, true));
    });
    res.json(body);
  });
  router.get('/reservations/:id/payment-attempts', async (req, res) => {
    const body = await withAuthorizedSession(pool, config, sessionCookie(req, config), (db, session) =>
      listPayments(db, session.user.id, parse(reservationId, req.params.id, true), parse(paymentPageQuery, req.query)));
    res.json(body);
  });
  return router;
}
