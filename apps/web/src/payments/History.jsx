import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { priceLabel, utcWhen } from '../discovery/model.js';
import { paymentOutcome } from './model.js';
import { CheckoutError } from './client.js';
import { readAccountPayments, paymentHistoryCheckoutPath } from './history.js';
import '../bookings/receipts.css';
import './history.css';

export function PaymentHistory() {
  const auth = useAuth();
  return <AccountHistory key={auth.session.user.id} />;
}
function AccountHistory() {
  const [cursor,setCursor] = useState(undefined);
  return <HistoryPage key={cursor||'newest'} cursor={cursor} onCursor={setCursor} />;
}
function HistoryPage({ cursor, onCursor }) {
  const auth = useAuth(), version = useRef(0), controller = useRef(null), refresh = useRef(null), heading = useRef(null);
  const [state,setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    const load = async () => {
      const own = ++version.current; controller.current?.abort(); const current = new AbortController(); controller.current = current;
      setState({ loading: true, data: null, error: null });
      try {
        const data = await readAccountPayments({ cursor, signal: current.signal });
        if (own===version.current && !current.signal.aborted) setState({ loading: false, data, error: null });
      } catch(error) {
        if (own===version.current && !current.signal.aborted) setState({ loading: false, data: null, error });
      }
    };
    refresh.current = load; document.title = 'SeatLedger - Your payments'; heading.current?.focus(); load();
    const onFocus = () => { if (document.visibilityState==='visible') load(); };
    window.addEventListener('focus',onFocus); document.addEventListener('visibilitychange',onFocus);
    return () => { ++version.current; controller.current?.abort(); refresh.current = null;
      window.removeEventListener('focus',onFocus); document.removeEventListener('visibilitychange',onFocus); };
  }, [cursor]);
  return <main id="main" className="discovery-page receipts-page payment-history-page">
    <Link className="programme-back" to="/account">Your account</Link>
    <header><p className="eyebrow">SEATLEDGER / YOUR BOX OFFICE</p><h1 tabIndex="-1" ref={heading}>Every attempt,<br /><em>saved.</em></h1>
      <p>Simulated payments only. No real money charged. Find a payment here and reopen its checkout to check the current outcome or refund.</p></header>
    <div className="receipt-toolbar"><span>NEWEST PAYMENT ATTEMPTS FIRST</span><button className="text-button" disabled={state.loading} onClick={() => refresh.current?.()}>Refresh payments</button></div>
    {state.loading && <p role="status">Checking your saved payment attempts.</p>}
    {state.error && <div className="receipt-error" role="alert"><p>{state.error instanceof CheckoutError ? state.error.message : 'Your payments could not be checked.'}</p>
      {[401,403].includes(state.error?.status) && <button className="secondary-button" onClick={() => auth.refresh()}>Check session</button>}</div>}
    {state.data && <><ol className="receipt-history">{state.data.items.map(payment => {
      const outcome = paymentOutcome(payment), programme = payment.currentProgramme;
      return <li key={payment.id}><div><p className="eyebrow">{payment.status} / SIMULATED</p><h2>{programme.title}</h2>
        <p>{priceLabel(payment.amountMinor,payment.currency)} / recorded <time dateTime={payment.createdAt}>{utcWhen(payment.createdAt)}</time></p>
        <p>{outcome.title}</p>
        {payment.resolution==='REFUND_REQUIRED' && <p>Open checkout for the separate current refund record.</p>}
        {payment.status==='FAILED' && <p>A delayed success may still change this outcome. Reopen checkout to check it.</p>}
        <p className="receipt-context">Current programme: {programme.venue}, {programme.city} / <time dateTime={programme.startsAt}>{utcWhen(programme.startsAt)}</time></p>
        <p className="payment-reference">Payment reference <code>{payment.id}</code></p></div>
        <div className="payment-history-actions"><Link className="quiet-link" to={paymentHistoryCheckoutPath(payment)}>Reopen checkout{payment.resolution==='REFUND_REQUIRED'?' & refund status':''}</Link>
          {payment.bookingId && <Link className="quiet-link" to={'/account/bookings/'+payment.bookingId}>View booking receipt</Link>}</div></li>;
    })}</ol>
      {!state.data.items.length && <p>No saved payment attempts were found on this page. A request whose server result is still unknown may need recovery in its original tab.</p>}
      <nav className="receipt-paging" aria-label="Payment history pages"><button className="secondary-button" disabled={!cursor} onClick={() => onCursor(undefined)}>Newest payments</button>
        <button className="secondary-button" disabled={!state.data.nextCursor} onClick={() => onCursor(state.data.nextCursor)}>Older payments</button></nav></>}
    <p className="receipt-context">These are saved payment attempts, including failed and refund-required outcomes. Opening a record never starts another payment. Keep the original tab for any request with an unconfirmed response.</p>
    <Link className="quiet-link" to="/account/bookings">Your bookings & saved receipts</Link>
  </main>;
}
