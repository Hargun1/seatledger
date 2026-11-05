import test from 'node:test';
import assert from 'node:assert/strict';
import { printableTickets, readPrintableTickets } from '../apps/web/src/bookings/printable.js';
import { bookingReturnPath } from '../apps/web/src/reservations/model.js';

const id = n => '90000000-0000-4000-8000-' + String(n).padStart(12, '0');
const stamp = '2026-11-04T21:00:00.123456Z';
function fixture() {
  const items = [5, 6].map(n => ({ id: id(n), section: 'Stalls', row: 'A', number: n, priceMinor: 75000, currency: 'INR' }));
  const booking = { id: id(1), reservationId: id(2), showId: id(3), status: 'CONFIRMED', paymentMode: 'simulated',
    createdAt: stamp, cancelledAt: null, totalMinor: 150000, currency: 'INR', seatCount: 2, items,
    currentProgramme: { current: true, eventId: id(4), title: 'A local evening', startsAt: '2030-01-01T18:00:00Z', venue: 'The room', city: 'Bengaluru', timezone: 'Asia/Kolkata' } };
  const tickets = items.map((s, i) => ({ id: id(8 + i), seatId: s.id, section: s.section, row: s.row, number: s.number,
    issuedAt: stamp, status: i ? 'USED' : 'ISSUED', credential: i ? null : 'sl1.' + id(8) + '.' + 'a'.repeat(43) }));
  return { booking, data: { bookingId: booking.id, showId: booking.showId, paymentMode: 'simulated', tickets } };
}
test('print projection withholds unavailable credentials and binds every ticket to immutable seat facts', () => {
  const { booking, data } = fixture(), result = printableTickets(booking, data);
  assert.equal(result.tickets.length, 1); assert.equal(result.withheld, 1); assert.equal(result.tickets[0].priceMinor, 75000);
  assert.equal(printableTickets({ ...booking, status: 'CANCELLED', cancelledAt: stamp }, data).tickets.length, 0);
  for (const status of ['VOID', 'EXPIRED']) assert.equal(printableTickets(booking, { ...data, tickets: data.tickets.map(t => ({ ...t, status, credential: null })) }).tickets.length, 0);
  for (const first of [{ ...data.tickets[0], section: 'Changed label' }, { ...data.tickets[0], id: '[' }, { ...data.tickets[0], status: 'USED' }, { ...data.tickets[0], credential: 'bad' }]) {
    assert.throws(() => printableTickets(booking, { ...data, tickets: [first, data.tickets[1]] }));
  }
  assert.throws(() => printableTickets(booking, { ...data, tickets: [data.tickets[0], data.tickets[0]] }));
  assert.throws(() => printableTickets(booking, { ...data, tickets: [data.tickets[0]] }));
  assert.throws(() => printableTickets(booking, { ...data, showId: id(99) }));
  assert.equal(printableTickets(booking, { ...data, tickets: [] }).issuedCount, 0);
});
test('print preparation uses only fresh owned GETs, refuses errors without mutations and permits only its exact internal return path', async () => {
  const { booking, data } = fixture(), calls = [];
  const fetchImpl = async (path, options) => { calls.push({ path, options }); return Response.json(path.endsWith('/tickets') ? data : booking); };
  const first = await readPrintableTickets({ bookingId: booking.id, fetchImpl });
  assert.equal(first.tickets.length, 1); assert.equal(Number.isFinite(Date.parse(first.preparedAt)), true);
  const expired = { ...data, tickets: data.tickets.map(t => ({ ...t, status: 'EXPIRED', credential: null })) };
  const second = await readPrintableTickets({ bookingId: booking.id, fetchImpl: async (path, options) => { calls.push({ path, options }); return Response.json(path.endsWith('/tickets') ? expired : booking); } });
  assert.equal(second.tickets.length, 0);
  assert.equal(calls.length, 4); assert.ok(calls.every(c => (c.options.method === undefined || c.options.method === 'GET') && c.options.body === undefined
    && c.options.credentials === 'same-origin' && c.options.cache === 'no-store' && !c.path.includes('sl1.')));
  await assert.rejects(readPrintableTickets({ bookingId: booking.id, fetchImpl: async () => Response.json({ error: 'private-payload' }, { status: 403 }) }), e => e.status === 403 && !e.message.includes('private-payload'));
  await assert.rejects(readPrintableTickets({ bookingId: undefined, fetchImpl: () => { throw new Error('Must not fetch'); } }), e => e.status === 404);
  const path = '/account/bookings/' + booking.id + '/tickets/print'; assert.equal(bookingReturnPath(path), path);
  for (const bad of [path + '?credential=x', path + '/extra', path + '/', '//example.invalid' + path, 'https://example.invalid' + path]) assert.equal(bookingReturnPath(bad), null);
});
