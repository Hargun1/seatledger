// Domain rules, not database writes. Transaction services must enforce these
// after acquiring locks and checking ownership, prices and database expiry.
export const transitions = Object.freeze({
  seat: { AVAILABLE: ['HELD'], HELD: ['AVAILABLE', 'BOOKED'], BOOKED: ['AVAILABLE'] },
  reservation: { ACTIVE: ['CONFIRMED', 'EXPIRED', 'RELEASED'], CONFIRMED: [], EXPIRED: [], RELEASED: [] },
  booking: { CONFIRMED: ['CANCELLED'], CANCELLED: [] },
  payment: { CREATED: ['PENDING', 'SUCCEEDED', 'FAILED'], PENDING: ['SUCCEEDED', 'FAILED'], FAILED: ['SUCCEEDED'], SUCCEEDED: [] },
  refund: { REQUESTED: ['PROCESSING'], PROCESSING: ['SUCCEEDED', 'RETRYABLE_FAILURE'], RETRYABLE_FAILURE: ['PROCESSING'], SUCCEEDED: [] },
  idempotency: { IN_PROGRESS: ['COMPLETED'], COMPLETED: [] },
  outbox: { READY: ['PROCESSING'], PROCESSING: ['RETRY_WAIT', 'SUCCEEDED', 'DEAD_LETTER'], RETRY_WAIT: ['PROCESSING'], SUCCEEDED: [], DEAD_LETTER: ['RETRY_WAIT'] }
});

export function canTransition(machine, from, to) {
  return transitions[machine]?.[from]?.includes(to) ?? false;
}

export function requireTransition(machine, from, to) {
  if (!canTransition(machine, from, to)) throw new Error(`Invalid ${machine} transition: ${from} -> ${to}`);
}
