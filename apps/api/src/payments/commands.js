import { createHash } from 'node:crypto';
import { z } from 'zod';
import { reservationId, parseReservationValue as parse } from '../reservations/commands.js';

const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const paymentPageQuery = z.object({ after: reservationId.optional() }).strict();
export function paymentCommand(userId, key, rawBody, id) {
  const user = parse(reservationId, userId), checkedKey = parse(keySchema, key);
  parse(z.object({}).strict(), rawBody);
  const body = { reservationId: parse(reservationId, id, true) };
  return { body, input: { userId: user, operation: 'payment.create', key: checkedKey,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest() } };
}
