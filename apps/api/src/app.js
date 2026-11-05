import express from 'express';
import { createAuthRouter } from './auth/routes.js';
import { createOrganizerRouter } from './organizers/routes.js';
import { createDiscoveryRouter } from './discovery/routes.js';
import { createReservationRouter } from './reservations/routes.js';
import { createPaymentRouter } from './payments/routes.js';
import { createBookingRouter } from './bookings/routes.js';
import { createTicketRouter } from './bookings/tickets.js';
import { createCheckinRouter } from './bookings/checkins.js';
import { createCancellationRouter } from './bookings/cancellation.js';
import { createOperationsRouter } from './organizers/operations.js';
import { createEventCancellationRouter } from './organizers/event-cancellation.js';
import { createSimulatedCallbackRouter } from './payments/callback-routes.js';
import { HttpError } from './http-error.js';

export function createApp({ pool, logger, config, authLimits }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');next();});
  app.use((req, res, next) => {
    const start = performance.now();
    res.on('finish', () => logger.info({ method: req.method, status: res.statusCode, durationMs: Math.round(performance.now() - start) }, 'request'));
    next();
  });
  // Signature verification needs the received bytes before JSON parsing.
  if(config) app.use('/api/payments/simulated/events',createSimulatedCallbackRouter({pool,secret:config.SIMULATOR_WEBHOOK_SECRET}));
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'seatledger-api', paymentMode: 'simulated' }));
  app.get('/api/ready', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready', database: 'available', paymentMode: 'simulated' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unavailable', paymentMode: 'simulated' });
    }
  });
  // The actual server always supplies validated configuration. Health-only
  // test/verifier factories can omit it without provisioning auth credentials.
  if(config) app.use('/api/auth',createAuthRouter({pool,config,limits:authLimits}));
  if(config) app.use('/api',createOrganizerRouter({pool,config}));
  if(config) app.use('/api',createReservationRouter({pool,config}));
  if(config) app.use('/api',createPaymentRouter({pool,config}));
  if(config) app.use('/api',createBookingRouter({pool,config}));
  if(config) app.use('/api',createTicketRouter({pool,config}));
  if(config) app.use('/api',createCheckinRouter({pool,config}));
  if(config) app.use('/api',createCancellationRouter({pool,config}));
  if(config) app.use('/api',createOperationsRouter({pool,config}));
  if(config) app.use('/api',createEventCancellationRouter({pool,config}));
  app.use('/api',createDiscoveryRouter({pool}));
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    const status = error instanceof HttpError ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    logger.error({ status }, 'request failed');
    if(error.retryAfter) res.set('Retry-After',String(Math.max(1,error.retryAfter)));
    res.status(status).json({ error: error instanceof HttpError ? error.code : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
      ...(error instanceof HttpError && error.code === 'SEATS_UNAVAILABLE' ? { unavailableSeatIds: error.unavailableSeatIds } : {}) });
  });
  return app;
}
