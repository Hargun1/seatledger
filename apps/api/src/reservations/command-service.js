import { claimIdempotency, completeIdempotency } from '../reliability/idempotency.js';
import { HttpError } from '../http-error.js';
import { createReservation, releaseReservation } from './service.js';
import { reservationCommand } from './commands.js';

// Shared orchestration for the original HTTP API and confirmed assistant
// proposals. Caller owns authorization and the transaction through COMMIT.
export async function executeReservationCommand(db, userId, operation, key, rawBody, { id, closeOnly = false, validateSaved } = {}) {
  const { input, body } = reservationCommand(operation, userId, key, rawBody, id);
  const claim = await claimIdempotency(db, input);
  if (claim.kind === 'conflict') throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
  if (claim.kind === 'replay') { if (validateSaved && claim.status < 300) await validateSaved(claim.body); return { status: claim.status, body: claim.body }; }
  if (closeOnly) {
    const receipt = { error: 'REQUEST_CLOSED', operation: input.operation, requestKey: input.key, paymentMode: 'simulated' };
    await completeIdempotency(db, input, 409, receipt);
    return { status: 409, body: receipt };
  }
  const saved = operation === 'reservation.create' ? await createReservation(db, userId, body) : await releaseReservation(db, userId, body.id);
  if (validateSaved) await validateSaved(saved);
  const status = operation === 'reservation.create' ? 201 : 200;
  await completeIdempotency(db, input, status, saved);
  return { status, body: saved };
}
