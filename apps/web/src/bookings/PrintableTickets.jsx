import React, { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { priceLabel } from '../discovery/model.js';
import { ReceiptError } from './client.js';
import { readPrintableTickets } from './printable.js';
import { TicketQr } from './TicketQr.jsx';
import './printable.css';

export function PrintableTickets() {
  const { bookingId } = useParams(), auth = useAuth();
  return <PrintPage key={[auth.session.user.id, auth.session.csrfToken, bookingId].join(':')} bookingId={bookingId?.toLowerCase()} />;
}
function PrintPage({ bookingId }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const version = useRef(0), controller = useRef(null), busy = useRef(false), heading = useRef(null), feedback = useRef(null);
  async function prepare(print = false) {
    if (busy.current) return;
    busy.current = true; const own = ++version.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setState({ loading: true, data: null, error: '' });
    try {
      const data = await readPrintableTickets({ bookingId, signal: abort.signal });
      if (own !== version.current || abort.signal.aborted) return;
      if (print && data.tickets.length) {
        // Commit this newly read snapshot to the DOM before the native print dialog.
        flushSync(() => setState({ loading: false, data, error: '' }));
        if (own !== version.current || abort.signal.aborted) return;
        window.print();
      } else setState({ loading: false, data, error: '' });
    } catch (error) {
      if (own === version.current && !abort.signal.aborted) setState({ loading: false, data: null,
        error: error instanceof ReceiptError ? error.message : 'The print preview could not be prepared. Refresh before printing.' });
    } finally { if (own === version.current) busy.current = false; }
  }
  useEffect(() => {
    document.title = 'SeatLedger - Private printable tickets'; heading.current?.focus(); void prepare();
    return () => { ++version.current; controller.current?.abort(); busy.current = false; };
  }, [bookingId]);
  useEffect(() => { if (state.error || (state.data && !state.data.tickets.length)) feedback.current?.focus(); }, [state.error, state.data]);
  function hide() {
    if (busy.current) return;
    ++version.current; controller.current?.abort(); setState({ loading: false, data: null, error: '' });
  }
  const data = state.data, programme = data?.booking.currentProgramme;
  return <main id="main" className="discovery-page ticket-print-page" aria-busy={state.loading}>
    <div className="print-controls"><Link className="programme-back" to={'/account/bookings/' + bookingId}>Back to saved booking</Link>
      <header><p className="eyebrow">SEATLEDGER / PRIVATE TICKET COPY</p><h1 tabIndex="-1" ref={heading}>Your place<br /><em>on paper.</em></h1>
        <p>These tickets contain private admission credentials. Keep the preview, paper and saved PDF private.</p></header>
      <div className="print-actions"><button className="primary-button" disabled={state.loading} onClick={() => prepare(true)}>Refresh & print / Save PDF</button>
        <button className="secondary-button" disabled={state.loading} onClick={() => prepare()}>Refresh private preview</button>
        <button className="text-button" disabled={state.loading || !data} onClick={hide}>Hide private preview</button></div>
      <p className="print-guidance">The print button refreshes current ticket status first. Your browser chooses the printer or Save as PDF. Nothing is issued or charged here.</p>
      <p className="print-guidance">Paper/PDF copies cannot update after a check-in or cancellation. Staff scan the private QR or paste its code, then the entrance register checks live status.</p>
      {state.loading && <p role="status">Preparing current owned tickets.</p>}
      {state.error && <p ref={feedback} tabIndex="-1" role="alert">{state.error}</p>}
      {data && !data.tickets.length && <div ref={feedback} tabIndex="-1" role="status"><h2>No printable admission tickets.</h2><p>{data.issuedCount ? 'Used, void, expired or cancelled tickets are withheld.' : 'No tickets have been issued. Return to the saved booking to issue or recover them explicitly.'}</p></div>}
      {data?.withheld > 0 && <p role="status">{data.withheld} ticket(s) withheld from this copy because they are no longer available for admission.</p>}
      {!state.loading && !data && !state.error && <p role="status">The private preview is hidden. Refresh to prepare it again.</p>}
    </div>
    {data?.tickets.map(ticket => <article className="print-ticket" key={ticket.id} aria-label={`${ticket.section}, row ${ticket.row}, seat ${ticket.number}`}>
      <div className="print-ticket-top"><strong>seatledger</strong><span>SIMULATED ADMISSION / NO REAL MONEY</span></div>
      <div className="print-ticket-main"><p className="print-kicker">CURRENT PROGRAMME INFORMATION</p><h2>{programme.title}</h2>
        <p>{programme.venue}, {programme.city}</p><p><time dateTime={programme.startsAt}>{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: programme.timezone }).format(new Date(programme.startsAt))}</time> / {programme.timezone}</p>
        <div className="print-seat"><div><span>SAVED SECTION</span><strong>{ticket.section}</strong></div><div><span>ROW</span><strong>{ticket.row}</strong></div><div><span>SEAT</span><strong>{ticket.number}</strong></div></div>
        <p className="print-saved-price">Saved seat price: {priceLabel(ticket.priceMinor, ticket.currency)} / simulated payment</p>
        <div className="print-private-code"><span>PRIVATE ADMISSION QR & CREDENTIAL</span><TicketQr credential={ticket.credential} /><code>{ticket.credential}</code><p>Staff must verify this code in the selected show's entrance register. A copy or screenshot never grants a second entry.</p></div>
      </div><dl className="print-ticket-record"><div><dt>BOOKING</dt><dd>{data.booking.id}</dd></div><div><dt>TICKET</dt><dd>{ticket.id}</dd></div></dl>
      <p className="print-ticket-foot">Prepared {data.preparedAt} (device clock). Status is a snapshot, not a guarantee of later admission. Seat labels/prices are saved facts; programme details can change.</p>
    </article>)}
  </main>;
}
