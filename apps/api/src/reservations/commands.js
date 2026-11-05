import { createHash } from 'node:crypto';
import { z } from 'zod';
import { reservationInput } from '@seatledger/shared';
import { HttpError } from '../http-error.js';

export const reservationId = z.uuid().transform(value => value.toLowerCase());
export const reservationRecoveryQuery = z.object({ showId: reservationId, after: reservationId.optional() }).strict();
const requestKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const emptyBody = z.object({}).strict();
export function parseReservationValue(schema, value, missing = false) {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(missing ? 404 : 400, missing ? 'NOT_FOUND' : 'INVALID_REQUEST');
  return result.data;
}

// Pure command construction. No connection, clock, allocation or retry lives
// here. The caller authenticates and verifies CSRF before entering this code.
export function reservationCommand(operation, userId, key, rawBody, id) {
  if (!['reservation.create', 'reservation.release'].includes(operation)) throw new HttpError(400, 'INVALID_REQUEST');
  const user = parseReservationValue(reservationId, userId);
  const checkedKey = parseReservationValue(requestKey, key);
  let body;
  if (operation === 'reservation.create') {
    body = parseReservationValue(reservationInput, rawBody);
    body.seatIds.sort();
  } else {
    parseReservationValue(emptyBody, rawBody);
    body = { id: parseReservationValue(reservationId, id, true) };
  }
  return { body, input: { userId: user, operation, key: checkedKey,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest() } };
}
