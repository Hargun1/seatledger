import { bookingRequest, validBooking, ReceiptError } from './client.js';
import { ticketRequest } from './tickets.js';
import { canonicalId } from '../payments/model.js';
import { instant } from '../discovery/model.js';

// A read-only print projection. Identity/status still come from current owned APIs.
export function printableTickets(booking, data) {
  if (!validBooking(booking, true) || data?.bookingId !== booking.id || data?.showId !== booking.showId
    || data?.paymentMode !== 'simulated' || !Array.isArray(data.tickets)
    || !(data.tickets.length === 0 || data.tickets.length === booking.items.length)) throw new ReceiptError();
  const seenSeats = new Set(), seenTickets = new Set(), tickets = [];
  for (const ticket of data.tickets) {
    const seat = booking.items.find(item => item.id === ticket?.seatId);
    if (!seat || !canonicalId(ticket.id) || !instant(ticket.issuedAt) || seenSeats.has(ticket.seatId) || seenTickets.has(ticket.id)
      || ticket.section !== seat.section || ticket.row !== seat.row || ticket.number !== seat.number
      || !['ISSUED', 'USED', 'VOID', 'EXPIRED'].includes(ticket.status)) throw new ReceiptError();
    seenSeats.add(ticket.seatId); seenTickets.add(ticket.id);
    if (ticket.status === 'ISSUED') {
      if (typeof ticket.credential !== 'string' || !new RegExp('^sl1\\.' + ticket.id + '\\.[A-Za-z0-9_-]{43}$').test(ticket.credential)) throw new ReceiptError();
      if (booking.status === 'CONFIRMED') tickets.push({ ...ticket, priceMinor: seat.priceMinor, currency: seat.currency });
    } else if (ticket.credential !== null) throw new ReceiptError();
  }
  return { tickets, withheld: data.tickets.length - tickets.length, issuedCount: data.tickets.length };
}

export async function readPrintableTickets({ bookingId, signal, fetchImpl = globalThis.fetch }) {
  if (!canonicalId(bookingId)) throw new ReceiptError(404);
  const booking = await bookingRequest({ id: bookingId, signal, fetchImpl });
  const data = await ticketRequest({ bookingId, showId: booking.showId, seatIds: booking.items.map(item => item.id), signal, fetchImpl });
  return { booking, ...printableTickets(booking, data), preparedAt: new Date().toISOString() };
}
