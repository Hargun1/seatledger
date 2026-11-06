import { validId, instant } from '../discovery/model.js';
import { validAgreement } from '../reservations/model.js';

const text = (value, max = 2000) => typeof value === 'string' && value.length <= max;
const money = value => Number.isSafeInteger(value) && value >= 0;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const bookingPath = value => value === null || /^\/account\/bookings\/[a-f0-9-]{36}$/.test(value) && validId(value.split('/').at(-1));
const seats = value => Array.isArray(value) && value.length >= 1 && value.length <= 8
  && new Set(value.map(seat => seat.id)).size === value.length
  && value.every(seat => validId(seat.id) && text(seat.section, 120) && text(seat.row, 40)
    && Number.isInteger(seat.number) && seat.number > 0 && money(seat.priceMinor) && currency(seat.currency));
const offer = value => validId(value.offerRef) && validId(value.eventId) && validId(value.showId)
  && text(value.title, 160) && text(value.venue, 120) && text(value.city, 120) && instant(value.startsAt)
  && text(value.timezone, 100) && (() => { try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); return true; } catch { return false; } })();
const option = value => offer(value) && validId(value.optionRef) && seats(value.seats) && currency(value.currency)
  && money(value.totalMinor) && value.seats.every(seat => seat.currency === value.currency)
  && value.seats.reduce((sum, seat) => sum + seat.priceMinor, 0) === value.totalMinor;
const hold = value => validAgreement(value, value.showId) && validId(value.proposalId) && validId(value.eventId)
  && text(value.title, 160) && value.checkoutPath === `/events/${value.eventId}/shows/${value.showId}/checkout/${value.id}`
  && (value.bookingPath === undefined || bookingPath(value.bookingPath));
export function validCard(card) {
  if (!card) return false;
  if (card.type === 'event') return offer(card) && (card.fromTotalMinor === null || money(card.fromTotalMinor)) && currency(card.currency)
    && Number.isInteger(card.ticketCount) && card.ticketCount >= 1 && card.ticketCount <= 8 && instant(card.asOf);
  if (card.type === 'seats') return option(card);
  if (card.type === 'proposal') return option(card) && validId(card.id) && instant(card.expiresAt);
  if (card.type === 'hold') return hold(card);
  if (card.type === 'availability') return validId(card.offerRef) && text(card.title, 160) && Number.isInteger(card.availableCount)
    && card.availableCount >= 0 && card.availableCount <= 500 && instant(card.asOf);
  return card.type === 'status' && validId(card.reservationId) && ['ACTIVE','EXPIRED','RELEASED','CONFIRMED'].includes(card.effectiveStatus)
    && money(card.totalMinor) && currency(card.currency) && instant(card.expiresAt) && bookingPath(card.bookingPath);
}
export function validConversation(value, id) {
  return value && validId(value.id) && (!id || value.id === id) && value.paymentMode === 'simulated'
    && Number.isInteger(value.revision) && value.revision >= 0 && value.revision <= 100 && typeof value.busy === 'boolean'
    && instant(value.serverNow) && instant(value.expiresAt)
    && Array.isArray(value.messages) && value.messages.length <= 80 && value.messages.every(message => validId(message.id)
      && ['user','assistant'].includes(message.role) && text(message.text) && Array.isArray(message.cards)
      && message.cards.length <= 10 && message.cards.every(validCard))
    && (value.proposal === null || validCard({ ...value.proposal, type: 'proposal' }) && ['READY','EXPIRED','CONFIRMED'].includes(value.proposal.status))
    && (value.hold === null || hold(value.hold))
    && (value.pending === null || validId(value.pending.requestKey) && text(value.pending.message, 1500)
      && Number.isInteger(value.pending.revision) && ['PROCESSING','FAILED'].includes(value.pending.status));
}
const errors = {
  ASSISTANT_UNAVAILABLE: 'The assistant is not enabled yet. You can still use the programme and normal booking flow.',
  AI_RATE_LIMITED: 'The assistant has reached its request allowance. Try later or book through the programme.',
  AI_RETRY_LIMIT: 'This conversation has reached its retry or turn limit. Start a new conversation or use the programme.',
  AI_UNAVAILABLE: 'The AI service could not respond. Check this conversation, then retry the saved message.',
  AI_BUSY: 'The AI service is busy. Check this conversation before retrying.',
  AI_TIMEOUT: 'The assistant took too long. Check the conversation before retrying.',
  AI_TOOL_LIMIT: 'The assistant stopped at its tool limit. Check the conversation, then try a simpler request.',
  AI_INVALID_RESPONSE: 'The AI response could not be verified. Check the conversation before retrying.',
  AI_RESPONSE_LIMIT: 'The AI response exceeded its limit. Check the conversation before retrying.',
  AI_CONTEXT_LIMIT: 'This conversation is too large. Start a new conversation.',
  SEATS_UNAVAILABLE: 'Some seats were taken. Ask for fresh seat recommendations.',
  QUOTE_CHANGED: 'The show or price changed. Ask for a new booking summary before confirming.',
  QUOTE_EXPIRED: 'This booking summary expired. Ask for a fresh summary.',
  STALE_RECOMMENDATION: 'This recommendation changed. Check the conversation and choose a fresh option.',
  ASSISTANT_CONFLICT: 'The conversation changed in another request. Check its current status.',
  ASSISTANT_BUSY: 'A message is still processing. Check its current status.',
  ASSISTANT_LEASE_EXPIRED: 'This request lost its processing lease. Check the conversation before retrying.',
  ACTIVE_HOLD_EXISTS: 'This conversation already has an active hold. Continue to checkout or manage it there.',
  AUTH_REQUIRED: 'Your session ended. Sign in again to continue.',
  CSRF_REJECTED: 'Your session changed. Check your session before continuing.',
  NOT_FOUND: 'This conversation is unavailable or expired. Start a new conversation.',
  INVALID_REQUEST: 'The assistant request could not be accepted.',
  STORAGE_UNAVAILABLE: 'This tab cannot save its recovery reference. Enable session storage to continue safely.',
  UNKNOWN: 'The response could not be confirmed. Check the conversation before trying again.'
};
export class AssistantError extends Error {
  constructor(code, status = 0, uncertain = false) { super(errors[code] || errors.UNKNOWN); this.code = Object.hasOwn(errors, code) ? code : 'UNKNOWN'; this.status = status; this.uncertain = uncertain; }
}
export async function assistantRequest(action, { id, body, key, csrfToken, signal, fetchImpl = globalThis.fetch } = {}) {
  const write = ['create','message','confirm'].includes(action);
  if (!['status','read','create','message','confirm'].includes(action) || !['status','create'].includes(action) && !validId(id)) throw new AssistantError('INVALID_REQUEST', 400);
  if (write && (typeof csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken) || !validId(key))) throw new AssistantError('AUTH_REQUIRED', 401);
  let path = '/api/assistant/' + (action === 'status' ? 'status' : 'conversations' + (action === 'create' ? '' : '/' + id));
  if (action === 'message') path += '/messages'; if (action === 'confirm') path += '/confirm-hold';
  let response, data;
  try {
    response = await fetchImpl(path, { method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      ...(write ? { headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken, 'Idempotency-Key': key }, body: JSON.stringify(body || {}) } : {}) });
    data = await response.json();
  } catch { throw new AssistantError('UNKNOWN', 0, write); }
  if (!response.ok) throw new AssistantError(data?.error, response.status, write && response.status >= 500);
  if (action === 'status' ? typeof data?.enabled !== 'boolean' || data.paymentMode !== 'simulated' : !validConversation(data, action === 'create' ? undefined : id))
    throw new AssistantError('UNKNOWN', 0, write);
  return data;
}
