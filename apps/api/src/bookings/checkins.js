import { Router } from 'express';
import { z } from 'zod';
import { withAuthorizedSession } from '../auth/authorized-transaction.js';
import { browserMutation, sessionCookie, verifyCsrf } from '../auth/security.js';
import { lockOrganizationAccess } from '../organizers/service.js';
import { lockShowGate, lockShowSeats } from '../reservations/service.js';
import { reservationId, parseReservationValue as parse } from '../reservations/commands.js';
import { verifyTicketCredential } from './tickets.js';
import { HttpError } from '../http-error.js';

const empty = z.object({}).strict();
const scanInput = z.object({
  credential: z.string().max(84),
  requestKey: reservationId
}).strict();
const checkinColumns = `t.id AS "ticketId", c.booking_item_id AS "bookingItemId", c.show_id AS "showId",
  c.checked_by AS "checkedBy", c.request_key AS "requestKey",
  to_char(c.checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "checkedAt",
  i.section_name AS section, i.row_label AS row, i.seat_number AS number`;

async function lockStaffShow(db, session, organizerId, showId) {
  // Authorization locks precede catalogue and allocation locks, on every path.
  await lockOrganizationAccess(db, session, organizerId);
  const show = (await db.query('SELECT id FROM shows WHERE id=$1 AND organizer_id=$2', [showId, organizerId])).rows[0];
  if (!show) throw new HttpError(404, 'NOT_FOUND');
  await lockShowGate(db, showId, false);
}

async function findRequest(db, requestKey) {
  return (await db.query(`SELECT ${checkinColumns} FROM ticket_checkins c
    JOIN admission_tickets t ON t.booking_item_id=c.booking_item_id
    JOIN booking_items i ON i.id=c.booking_item_id WHERE c.request_key=$1`, [requestKey])).rows[0];
}

function result(row, newlyRecorded = false) {
  // A recovered receipt describes history. It must never be another green scan.
  const { checkedBy, ...checkin } = row;
  return { status: newlyRecorded ? 'CHECKED_IN' : 'ALREADY_RECORDED',
    admissionGranted: newlyRecorded, paymentMode: 'simulated', checkin };
}

export async function recoverCheckin(db, session, organizerId, showId, requestKey) {
  await lockStaffShow(db, session, organizerId, showId);
  const row = await findRequest(db, requestKey);
  if (!row || row.showId !== showId || row.checkedBy !== session.user.id) throw new HttpError(404, 'NOT_FOUND');
  return result(row);
}

// The caller owns the authorization transaction. No network call is made here.
export async function checkInTicket(db, session, organizerId, showId, { credential, requestKey }, secret) {
  await lockStaffShow(db, session, organizerId, showId);
  const ticketId = verifyTicketCredential(credential, secret);
  if (!ticketId) throw new HttpError(404, 'NOT_FOUND');
  const ticket = (await db.query(`SELECT t.booking_item_id, t.booking_id, b.reservation_id
    FROM admission_tickets t JOIN bookings b ON b.id=t.booking_id
    WHERE t.id=$1 AND t.show_id=$2`, [ticketId, showId])).rows[0];
  if (!ticket) throw new HttpError(404, 'NOT_FOUND');
  const items = (await db.query(`SELECT venue_seat_id FROM booking_items
    WHERE booking_id=$1 ORDER BY venue_seat_id`, [ticket.booking_id])).rows;
  if (items.length < 1 || items.length > 8) throw new HttpError(409, 'TICKET_UNAVAILABLE');
  // Whole-booking ordering matches issuance/confirmation and future cancellation.
  await lockShowSeats(db, showId, items.map(item => item.venue_seat_id));
  await db.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE', [ticket.reservation_id]);
  await db.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [ticket.booking_id]);
  await db.query('SELECT id FROM payment_attempts WHERE booking_id=$1 ORDER BY id FOR UPDATE', [ticket.booking_id]);

  const previous = await findRequest(db, requestKey);
  if (previous) {
    if (previous.ticketId !== ticketId || previous.showId !== showId || previous.checkedBy !== session.user.id) {
      throw new HttpError(409, 'CHECKIN_REQUEST_CONFLICT');
    }
    return result(previous); // Recovery remains history even after the show ends.
  }
  if ((await db.query('SELECT 1 FROM ticket_checkins WHERE booking_item_id=$1', [ticket.booking_item_id])).rowCount) {
    throw new HttpError(409, 'TICKET_ALREADY_USED');
  }

  async function eligible() {
    return (await db.query(`SELECT b.status='CONFIRMED' AND b.sealed_at IS NOT NULL AND r.status='CONFIRMED'
      AND s.status='SCHEDULED' AND s.starts_at>clock_timestamp() AND e.status='PUBLISHED'
      AND EXISTS(SELECT 1 FROM payment_attempts p WHERE p.booking_id=b.id AND p.status='SUCCEEDED' AND p.resolution='BOOKED')
      AND NOT EXISTS(SELECT 1 FROM booking_items i LEFT JOIN show_seats stock
        ON stock.show_id=i.show_id AND stock.venue_seat_id=i.venue_seat_id
        WHERE i.booking_id=b.id AND (stock.state IS DISTINCT FROM 'BOOKED'
          OR stock.booking_id IS DISTINCT FROM b.id OR stock.reservation_id IS DISTINCT FROM b.reservation_id)) AS valid
      FROM bookings b JOIN reservations r ON r.id=b.reservation_id JOIN shows s ON s.id=b.show_id
      JOIN events e ON e.id=s.event_id WHERE b.id=$1`, [ticket.booking_id])).rows[0]?.valid;
  }
  if (!await eligible()) throw new HttpError(409, 'TICKET_UNAVAILABLE');
  const inserted = await db.query(`INSERT INTO ticket_checkins(booking_item_id,show_id,organizer_id,checked_by,request_key)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING booking_item_id`,
  [ticket.booking_item_id, showId, organizerId, session.user.id, requestKey]);
  // Covers a simultaneous request-key reuse on a different booking too.
  if (!inserted.rowCount) throw new HttpError(409, 'CHECKIN_REQUEST_CONFLICT');
  await db.query(`INSERT INTO audit_events(operation_id,actor_kind,actor_user_id,action,entity_type,entity_id,organizer_id,metadata)
    VALUES($1,'USER',$2,'ticket.checked_in','ticket',$3,$4,$5)`,
  [requestKey, session.user.id, ticketId, organizerId, { showId, bookingItemId: ticket.booking_item_id }]);
  const recorded = await findRequest(db, requestKey);
  // Wall-clock eligibility is checked AFTER insertion and audit, not just at BEGIN.
  if (!await eligible()) throw new HttpError(409, 'TICKET_UNAVAILABLE');
  return result(recorded, true);
}

export function createCheckinRouter({ pool, config }) {
  const router = Router();
  const path = '/organizers/:organizerId/shows/:showId/check-ins';
  router.use(path, (req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next();
  });
  const scope = req => [parse(reservationId, req.params.organizerId, true), parse(reservationId, req.params.showId, true)];
  router.post(path, browserMutation(config), async (req, res) => {
    const value = await withAuthorizedSession(pool, config, sessionCookie(req, config), async (db, session) => {
      verifyCsrf(req, session); parse(empty, req.query);
      return checkInTicket(db, session, ...scope(req), parse(scanInput, req.body), config.AUTH_SECRET);
    });
    res.status(value.admissionGranted ? 201 : 200).json(value); // Only after COMMIT.
  });
  router.get(path + '/:requestKey', async (req, res) => {
    const value = await withAuthorizedSession(pool, config, sessionCookie(req, config), async (db, session) => {
      parse(empty, req.query);
      return recoverCheckin(db, session, ...scope(req), parse(reservationId, req.params.requestKey, true));
    });
    res.json(value);
  });
  return router;
}
