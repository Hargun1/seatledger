import { Router } from 'express';
import { publicId, publicPage, discoveryInput, noQuery, parsePublic } from './policy.js';
import { discoverEvents, publicEvent, publicSeats } from './service.js';

export function createDiscoveryRouter({ pool }) {
  const router = Router();
  router.use('/events', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/events', async (req, res) => res.json(await discoverEvents(pool, parsePublic(discoveryInput, req.query))));
  router.get('/events/:eventId', async (req, res) => res.json(await publicEvent(pool,
    parsePublic(publicId, req.params.eventId, true), parsePublic(publicPage, req.query))));
  router.get('/events/:eventId/shows/:showId/seats', async (req, res) => {
    const eventId = parsePublic(publicId, req.params.eventId, true), showId = parsePublic(publicId, req.params.showId, true);
    parsePublic(noQuery, req.query);
    res.json(await publicSeats(pool, eventId, showId));
  });
  return router;
}
