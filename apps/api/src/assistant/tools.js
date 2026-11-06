import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { discoverEvents, publicEvent, publicSeats } from '../discovery/service.js';
import { readReservation } from '../reservations/service.js';
import { listPayments } from '../payments/service.js';
import { HttpError } from '../http-error.js';
import { preferencesSchema, offerSchema, seatsSchema, proposalSchema, statusSchema, clarificationSchema, parse } from './schemas.js';
import { defaultPreferences, mergePreferences, dateWindow, recommendSeatGroups } from './preferences.js';

const definitions = [
  ['searchEvents', 'Search current published events. Nullable fields keep prior preferences; use when=any or budgetScope=none to clear those filters. Amounts are integer INR paise. Dates use Asia/Kolkata.', preferencesSchema],
  ['getEventDetails', 'Read a currently offered event. Use an offerRef returned by searchEvents, never invent an identifier.', offerSchema],
  ['getAvailableSeats', 'Read current advisory availability for an offered show. This never reserves inventory.', offerSchema],
  ['recommendSeats', 'Compute available seat options and totals on the server. Adjacent seats must be in one row/section with consecutive seat numbers.', seatsSchema],
  ['createSeatHold', 'Prepare a booking summary from an optionRef. This tool CANNOT reserve seats. The customer must use the separate confirmation action; never claim a hold exists from this tool.', proposalSchema],
  ['getBookingStatus', 'Read the authenticated customer\'s reservation/payment status. Null uses the last confirmed hold. No payments are created.', statusSchema],
  ['clarifyPreferences', 'Ask a safe, specific clarification about missing or ambiguous customer preferences. Choose the field; the server supplies the question.', clarificationSchema]
];
export const toolDefinitions = definitions.map(([name, description, schema]) => {
  const parameters = z.toJSONSchema(schema); delete parameters.$schema;
  return { type: 'function', function: { name, description, strict: true, parameters } };
});
const schemas = Object.fromEntries(definitions.map(([name, , schema]) => [name, schema]));
const aliases = (value, kind) => {
  if (!value) return [undefined];
  const key = value.toLowerCase();
  if (kind === 'city' && ['bangalore','bengaluru'].includes(key)) return ['Bengaluru','Bangalore'];
  const categories = { comedy: ['Comedy','Stand-up','Stand-up comedy'], concert: ['Music','Concert','Concerts'],
    concerts: ['Music','Concert','Concerts'], music: ['Music','Concert','Concerts'], movie: ['Movies','Movie','Cinema'], movies: ['Movies','Movie','Cinema'] };
  return kind === 'category' ? categories[key] || [value] : [value];
};
const iso = value => new Date(value).toISOString();
export const initialContext = () => ({ preferences: defaultPreferences(), offers: {}, options: {}, proposal: null, hold: null });

export function createToolExecutor({ pool, state, authorize, deadline = Infinity }) {
  const cards = [], cached = new Map(); let clarification = null;
  const now = async () => new Date((await pool.query('SELECT clock_timestamp() AS now')).rows[0].now);
  const offer = ref => { const value = state.offers[ref]; if (!value) throw new HttpError(409, 'STALE_RECOMMENDATION'); return value; };
  const eventCard = value => ({ type: 'event', ...value, eventPath: `/events/${value.eventId}`,
    offerNumber: Object.keys(state.offers).indexOf(value.offerRef) + 1, seatingPath: `/events/${value.eventId}/shows/${value.showId}/seats` });
  async function execute(name, raw) {
    if (Date.now() >= deadline) throw new HttpError(504, 'AI_TIMEOUT');
    if (!Object.hasOwn(schemas, name)) throw new HttpError(400, 'INVALID_TOOL');
    const args = parse(schemas[name], raw), cacheKey = name + ':' + JSON.stringify(args);
    if (cached.has(cacheKey)) return cached.get(cacheKey);
    let result;
    if (name === 'searchEvents') {
      const preferences = mergePreferences(state.preferences, args), window = dateWindow(preferences, await now());
      const events = new Map(); let truncated = false;
      for (const city of aliases(preferences.city, 'city')) for (const category of aliases(preferences.category, 'category')) {
        const page = await discoverEvents(pool, { limit: 20, ...(city ? { city } : {}), ...(category ? { category } : {}),
          ...(window ? { from: window.start.slice(0, 10), to: window.end.slice(0, 10) } : {}) });
        truncated ||= Boolean(page.nextCursor);
        for (const event of page.items) if (events.size < 20) events.set(event.id, event); else truncated = true;
      }
      state.preferences = preferences; state.offers = {}; state.options = {}; state.proposal = null;
      const offers = []; let inspected = 0;
      eventLoop: for (const event of events.values()) {
        if (Date.now() >= deadline) throw new HttpError(504, 'AI_TIMEOUT');
        if (offers.length >= 8) { truncated = true; break; }
        const details = await publicEvent(pool, event.id, { limit: 50 }); truncated ||= Boolean(details.shows.nextCursor);
        for (const show of details.shows.items) {
          if (++inspected > 24) { truncated = true; break eventLoop; }
          if (Date.now() >= deadline) throw new HttpError(504, 'AI_TIMEOUT');
          if (preferences.city && !aliases(preferences.city, 'city').some(city => city.toLowerCase() === show.venue.city.toLowerCase())) continue;
          const starts = iso(show.startsAt);
          if (window && !(starts >= window.start && starts < window.end)) continue;
          const map = await publicSeats(pool, event.id, show.id), options = recommendSeatGroups(map, preferences, 1);
          if (!options.length) continue;
          const group = options[0], value = { offerRef: randomUUID(), eventId: event.id, showId: show.id, title: event.title,
            category: event.category, startsAt: starts, venue: show.venue.name, city: show.venue.city, timezone: show.venue.timezone,
            ticketCount: preferences.ticketCount, fromTotalMinor: group.totalMinor, currency: group.currency,
            availableCount: map.seats.filter(seat => seat.state === 'AVAILABLE').length, asOf: iso(map.asOf) };
          offers.push(value);
          if (offers.length >= 8) { truncated = true; break; }
        }
      }
      offers.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.fromTotalMinor - b.fromTotalMinor || a.showId.localeCompare(b.showId));
      for (const value of offers) { state.offers[value.offerRef] = value; cards.push(eventCard(value)); }
      result = { preferences, dateWindow: window, offers, truncated, advisory: true };
    } else if (name === 'getEventDetails') {
      const value = offer(args.offerRef), map = await publicSeats(pool, value.eventId, value.showId);
      const group = recommendSeatGroups(map, state.preferences, 1)[0];
      const fresh = { ...value, title: map.event.title, category: map.event.category, venue: map.show.venue.name,
        city: map.show.venue.city, startsAt: iso(map.show.startsAt), timezone: map.show.venue.timezone,
        fromTotalMinor: group?.totalMinor ?? null, availableCount: map.seats.filter(seat => seat.state === 'AVAILABLE').length, asOf: iso(map.asOf) };
      state.offers[value.offerRef] = fresh;
      cards.push(eventCard(fresh)); result = { event: map.event, offer: fresh };
    } else if (name === 'getAvailableSeats' || name === 'recommendSeats') {
      const value = offer(args.offerRef), map = await publicSeats(pool, value.eventId, value.showId);
      if (name === 'getAvailableSeats') {
        result = { offerRef: value.offerRef, availableCount: map.seats.filter(seat => seat.state === 'AVAILABLE').length, asOf: iso(map.asOf), advisory: true };
        cards.push({ type: 'availability', title: map.event.title, ...result });
      }
      else {
        const preferences = { ...state.preferences };
        for (const key of ['ticketCount','adjacent','preference']) if (args[key] !== null) preferences[key] = args[key];
        state.preferences = preferences; state.options = {}; state.proposal = null;
        const groups = recommendSeatGroups(map, preferences);
        const options = groups.map((group, index) => {
          const option = { optionRef: randomUUID(), optionNumber: index + 1, offerRef: value.offerRef, eventId: value.eventId, showId: value.showId,
            title: value.title, venue: value.venue, city: value.city, startsAt: value.startsAt, timezone: value.timezone,
            ...group, asOf: iso(map.asOf) };
          state.options[option.optionRef] = option; cards.push({ type: 'seats', ...option }); return option;
        });
        // The model uses opaque option references and labels, never seat IDs.
        result = { options: options.map(({ seats, ...option }) => ({ ...option, seats: seats.map(({ section, row, number, priceMinor, currency }) => ({ section, row, number, priceMinor, currency })) })), advisory: true };
      }
    } else if (name === 'createSeatHold') {
      const option = state.options[args.optionRef]; if (!option) throw new HttpError(409, 'STALE_RECOMMENDATION');
      const map = await publicSeats(pool, option.eventId, option.showId);
      for (const quoted of option.seats) {
        const fresh = map.seats.find(seat => seat.id === quoted.id);
        if (!fresh || fresh.state !== 'AVAILABLE') throw new HttpError(409, 'SEATS_UNAVAILABLE');
        if (fresh.priceMinor !== quoted.priceMinor || fresh.currency !== quoted.currency) throw new HttpError(409, 'QUOTE_CHANGED');
      }
      const at = await now();
      state.proposal = { ...option, title: map.event.title, venue: map.show.venue.name, city: map.show.venue.city,
        startsAt: iso(map.show.startsAt), timezone: map.show.venue.timezone, id: randomUUID(), expiresAt: new Date(at.getTime() + 120000).toISOString() };
      cards.push({ type: 'proposal', ...state.proposal });
      result = { confirmationRequired: true, proposalId: state.proposal.id, totalMinor: option.totalMinor, currency: option.currency,
        seats: option.seats.map(({ section, row, number }) => ({ section, row, number })), expiresAt: state.proposal.expiresAt, held: false };
    } else if (name === 'clarifyPreferences') {
      const questions = { category: 'What kind of event would you like: comedy, music, a movie, or another category?',
        city: 'Which city would you like to search?', dates: 'Which date or weekend should I search? Dates use India time.',
        ticketCount: 'How many seats do you need? I can help with one to eight seats.',
        budget: 'What is your budget in rupees, and is that the total for all seats or the limit per ticket?',
        seating: 'Would you like adjacent seats, the cheapest options, or seats near the centre of a row?' };
      clarification = questions[args.field]; result = { question: clarification };
    } else {
      const reservationId = args.reservationId || state.hold?.id;
      if (!reservationId) throw new HttpError(404, 'NOT_FOUND');
      const status = await authorize(async (db, session) => ({ reservation: await readReservation(db, session.user.id, reservationId),
        payments: await listPayments(db, session.user.id, reservationId) }));
      const held = status.reservation, payment = status.payments.items.find(value => value.bookingId);
      cards.push({ type: 'status', reservationId: held.id, effectiveStatus: held.effectiveStatus, totalMinor: held.totalMinor,
        currency: held.currency, expiresAt: held.expiresAt, bookingPath: payment ? `/account/bookings/${payment.bookingId}` : null });
      result = { effectiveStatus: held.effectiveStatus, totalMinor: held.totalMinor, currency: held.currency, expiresAt: held.expiresAt,
        payments: status.payments.items.map(({ status, resolution }) => ({ status, resolution })) };
    }
    cached.set(cacheKey, result); return result;
  }
  return { execute, cards, get clarification() { return clarification; } };
}
