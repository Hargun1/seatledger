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
import { createTelemetry, validMetricsToken } from './observability.js';
import { withAuthorizedSession } from './auth/authorized-transaction.js';
import { sessionCookie } from './auth/security.js';

export function createApp({ pool, logger, config, authLimits,
  telemetry = createTelemetry({ logger, sampleRate: config?.TRACE_SAMPLE_RATE ?? Number(process.env.TRACE_SAMPLE_RATE ?? .05) }) }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{res.set({ 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer' });next();});
  app.use(telemetry.middleware);
  // Signature verification needs the received bytes before JSON parsing.
  if(config) app.use('/api/payments/simulated/events',createSimulatedCallbackRouter({pool,secret:config.SIMULATOR_WEBHOOK_SECRET}));
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'seatledger-api', paymentMode: 'simulated' }));
  if (config) app.get('/api/metrics', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!validMetricsToken(req.get('Authorization'), config.METRICS_TOKEN)) {
      await withAuthorizedSession(pool, config, sessionCookie(req, config), async (db, session) => {
        if (session.user.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN');
      });
    }
    const queues = (await pool.query(`SELECT kind,status,count(*)::int AS count,
      max(greatest(0,extract(epoch FROM clock_timestamp()-created_at)))::float8 AS age
      FROM outbox_events GROUP BY kind,status`)).rows;
    res.type('text/plain; version=0.0.4').send(telemetry.render(pool, queues));
  });
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
    const databaseBusy = ['timeout exceeded when trying to connect', 'Query read timeout'].includes(error.message);
    const status = error instanceof HttpError ? error.status : databaseBusy ? 503 : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const code = error instanceof HttpError ? error.code : databaseBusy ? 'DATABASE_BUSY' : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    const trace = telemetry.current();
    const fields = { status, code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN', requestId: trace?.requestId, traceId: trace?.traceId };
    if (status >= 500) logger.error(fields, 'request failed');
    else logger.info(fields, 'request rejected');
    if(error.retryAfter) res.set('Retry-After',String(Math.max(1,error.retryAfter)));
    else if (status === 503 && !res.hasHeader('Retry-After')) res.set('Retry-After', '1');
    res.status(status).json({ error: code,
      ...(error instanceof HttpError && error.code === 'SEATS_UNAVAILABLE' ? { unavailableSeatIds: error.unavailableSeatIds } : {}) });
  });
  return app;
}
