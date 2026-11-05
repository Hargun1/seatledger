import { Router } from 'express';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { browserMutation, sessionCookie, verifyCsrf } from '../auth/security.js';
import { organizerId, pageInput, reviewInput, organizationInput, decisionInput, draftInput, draftPatch, parseInput } from './policy.js';
import { requestOrganization, listMine, listReview, decideOrganization, listEvents, getEvent, createDraft, updateDraft } from './service.js';
import { venueInput, venuePatch, venueDelete, layoutInput } from '../venues/policy.js';
import { listVenues, getVenue, createVenue, patchVenue, replaceLayout, deleteVenue } from '../venues/service.js';
import { showInput, showPatch, showDelete } from '../shows/policy.js';
import { listShows, getShow, createShow, patchShow, deleteShow } from '../shows/service.js';
import { publishInput } from '../publication/policy.js';
import { reviewPublication, publishEvent, publicationStatus } from '../publication/service.js';

export function createOrganizerRouter({ pool, config }) {
  const router = Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  router.use('/organizers', noStore);
  router.use('/admin/organizers', noStore);
  const run = (work, { write = false, status = 200, exclusiveActor = false } = {}) => async (req, res) => {
    const result = await withAuthorizedSession(pool, config, sessionCookie(req, config), async (db, session) => {
      if (write) verifyCsrf(req, session);
      return work(req, db, session);
    }, { exclusiveActor });
    res.status(status).json(result); // Send success only after COMMIT.
  };
  const org = req => parseInput(organizerId, req.params.organizerId, { missing: true });
  const event = req => parseInput(organizerId, req.params.eventId, { missing: true });
  const venue = req => parseInput(organizerId, req.params.venueId, { missing: true });
  const show = req => parseInput(organizerId, req.params.showId, { missing: true });
  const boundary = browserMutation(config);

  router.get('/organizers', run((req, db, session) => listMine(db, session, parseInput(pageInput, req.query))));
  router.post('/organizers', boundary, run((req, db, session) => requestOrganization(db, session, parseInput(organizationInput, req.body)),
    { write: true, status: 201, exclusiveActor: true }));
  router.get('/admin/organizers', run((req, db, session) => listReview(db, session, parseInput(reviewInput, req.query))));
  router.post('/admin/organizers/:organizerId/status', boundary,
    run((req, db, session) => decideOrganization(db, session, org(req), parseInput(decisionInput, req.body)), { write: true }));

  router.get('/organizers/:organizerId/events', run((req, db, session) => listEvents(db, session, org(req), parseInput(pageInput, req.query))));
  router.get('/organizers/:organizerId/events/:eventId', run((req, db, session) => getEvent(db, session, org(req), event(req))));
  router.post('/organizers/:organizerId/events', boundary,
    run((req, db, session) => createDraft(db, session, org(req), parseInput(draftInput, req.body)), { write: true, status: 201 }));
  router.patch('/organizers/:organizerId/events/:eventId', boundary,
    run((req, db, session) => updateDraft(db, session, org(req), event(req), parseInput(draftPatch, req.body)), { write: true }));
  router.get('/organizers/:organizerId/venues', run((req, db, session) => listVenues(db, session, org(req), parseInput(pageInput, req.query))));
  router.post('/organizers/:organizerId/venues', boundary,
    run((req, db, session) => createVenue(db, session, org(req), parseInput(venueInput, req.body)), { write: true, status: 201 }));
  router.get('/organizers/:organizerId/venues/:venueId', run((req, db, session) => getVenue(db, session, org(req), venue(req))));
  router.patch('/organizers/:organizerId/venues/:venueId', boundary,
    run((req, db, session) => patchVenue(db, session, org(req), venue(req), parseInput(venuePatch, req.body)), { write: true }));
  router.put('/organizers/:organizerId/venues/:venueId/layout', boundary,
    run((req, db, session) => replaceLayout(db, session, org(req), venue(req), parseInput(layoutInput, req.body)), { write: true }));
  router.delete('/organizers/:organizerId/venues/:venueId', boundary,
    run((req, db, session) => deleteVenue(db, session, org(req), venue(req), parseInput(venueDelete, req.body)), { write: true }));
  router.get('/organizers/:organizerId/events/:eventId/shows',
    run((req, db, session) => listShows(db, session, org(req), event(req), parseInput(pageInput, req.query))));
  router.get('/organizers/:organizerId/events/:eventId/shows/:showId',
    run((req, db, session) => getShow(db, session, org(req), event(req), show(req))));
  router.post('/organizers/:organizerId/events/:eventId/shows', boundary,
    run((req, db, session) => createShow(db, session, org(req), event(req), parseInput(showInput, req.body)), { write: true, status: 201 }));
  router.patch('/organizers/:organizerId/events/:eventId/shows/:showId', boundary,
    run((req, db, session) => patchShow(db, session, org(req), event(req), show(req), parseInput(showPatch, req.body)), { write: true }));
  router.delete('/organizers/:organizerId/events/:eventId/shows/:showId', boundary,
    run((req, db, session) => deleteShow(db, session, org(req), event(req), show(req), parseInput(showDelete, req.body)), { write: true }));
  router.get('/organizers/:organizerId/events/:eventId/publication',
    run((req, db, session) => reviewPublication(db, session, org(req), event(req))));
  router.get('/organizers/:organizerId/events/:eventId/publication/status',
    run((req, db, session) => publicationStatus(db, session, org(req), event(req))));
  router.post('/organizers/:organizerId/events/:eventId/publish', boundary,
    run((req, db, session) => publishEvent(db, session, org(req), event(req), parseInput(publishInput, req.body)), { write: true }));
  return router;
}
