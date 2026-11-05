import express from 'express';
import { HttpError } from '../http-error.js';
import { verifySimulatedDelivery, SimulatedEventError, MAX_SIMULATED_EVENT_BYTES } from './events.js';
import { recordSimulatedEvent } from './inbox.js';

export function createSimulatedCallbackRouter({ pool, secret }) {
  const router = express.Router();
  router.post('/', (req,res,next) => {
    res.set('Cache-Control','no-store');
    if (!secret) return next(new HttpError(503,'SIMULATOR_EVENTS_DISABLED'));
    if (Object.keys(req.query).length) return next(new HttpError(400,'INVALID_SIMULATED_EVENT'));
    if (!req.is('application/json')) return next(new HttpError(415,'JSON_REQUIRED'));
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return next(new HttpError(415,'ENCODING_REJECTED'));
    const headers = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'x-seatledger-signature');
    if (headers.length !== 1) return next(new HttpError(401,'SIMULATED_EVENT_UNVERIFIED'));
    next();
  }, express.raw({ type:'application/json',limit:MAX_SIMULATED_EVENT_BYTES,inflate:false }), async (req,res,next) => {
    try {
      const verified = verifySimulatedDelivery(req.body,req.headers['x-seatledger-signature'],{ secret });
      await recordSimulatedEvent(pool,verified,req.body);
      res.status(202).json({ status:'recorded',paymentMode:'simulated' });
    } catch (error) {
      if (error instanceof SimulatedEventError && ['INVALID_EVENT_BODY','INVALID_EVENT_SIGNATURE','STALE_EVENT_DELIVERY'].includes(error.code)) return next(new HttpError(error.code === 'INVALID_EVENT_BODY' ? 400 : 401,
        error.code === 'INVALID_EVENT_BODY' ? 'INVALID_SIMULATED_EVENT' : 'SIMULATED_EVENT_UNVERIFIED'));
      if (error instanceof HttpError) return next(error);
      // Includes lost COMMIT acknowledgement: no positive receipt; retry the
      // same immutable event with a fresh delivery signature.
      res.set('Retry-After','5'); next(new HttpError(503,'EVENT_INBOX_UNAVAILABLE'));
    }
  });
  return router;
}
