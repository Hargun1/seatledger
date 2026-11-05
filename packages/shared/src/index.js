import { z } from 'zod';
export { loginInput, registerInput } from './auth-schemas.js';

export const PAYMENT_MODE = 'simulated';
export const HOLD_SECONDS = 300;
export const seatStates = Object.freeze(['AVAILABLE', 'HELD', 'BOOKED']);
export const reservationInput = z.object({
  showId: z.uuid().transform(value => value.toLowerCase()),
  seatIds: z.array(z.uuid().transform(value => value.toLowerCase())).min(1).max(8).refine(ids => new Set(ids).size === ids.length, 'Duplicate seats are not allowed')
}).strict();
