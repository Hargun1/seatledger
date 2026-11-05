import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { discoveryRequest } from '../discovery/client.js';
import { priceLabel, utcWhen, venueWhen } from '../discovery/model.js';
import { canonicalId, paymentOutcome } from './model.js';
import { CheckoutError } from './client.js';
import { createCheckoutStore } from './store.js';
import { RefundStatus } from './RefundStatus.jsx';
import { readBookingPolicy } from '../bookings/cancellation.js';
import './checkout.css';

const message = error => error instanceof CheckoutError ? error.message : 'We could not check checkout. Please try again.';
export function Checkout() {
  const params = useParams(), auth = useAuth();
  const [eventId, showId, reservationId] = [params.eventId, params.showId, params.reservationId].map(value => value?.toLowerCase());
  if (![eventId, showId, reservationId].every(canonicalId)) return <main id="main" className="message-page"><h1 tabIndex="-1">Checkout unavailable.</h1><p>Check the address or return to the programme.</p><Link to="/events">Explore the programme</Link></main>;
  return <CheckoutRoom key={`${auth.session.user.id}:${eventId}:${showId}:${reservationId}`} {...{ eventId, showId, reservationId }} />;
}
function CheckoutRoom({ eventId, showId, reservationId }) {
  const auth = useAuth(), csrf = useRef(auth.session.csrfToken); csrf.current = auth.session.csrfToken;
  const store = useMemo(() => createCheckoutStore({ userId: auth.session.user.id, showId, reservationId, getCsrf: () => csrf.current }), [auth.session.user.id, showId, reservationId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [map, setMap] = useState(null), [resolveConfirm, setResolveConfirm] = useState(false);
  const [policy,setPolicy] = useState(null), [policyError,setPolicyError] = useState(false), [policyRead,setPolicyRead] = useState(0);
  const pollCount = useRef(0), feedback = useRef(null);
  useEffect(() => {
    store.refresh(); const onFocus = () => { if (document.visibilityState === 'visible') store.refresh(); };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus);
    return () => { store.cancel(); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [store]);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    discoveryRequest('seats', { eventId, showId, signal: controller.signal }).then(value => { if (active) setMap(value); }).catch(() => {});
    return () => { active = false; controller.abort(); };
  }, [eventId, showId]);
  useEffect(() => { document.title = 'SeatLedger - Your simulated checkout'; document.querySelector('main h1')?.focus(); }, []);
  useEffect(()=>{
    const controller=new AbortController();let active=true;setPolicy(null);setPolicyError(false);
    readBookingPolicy({signal:controller.signal}).then(value=>{if(active)setPolicy(value);}).catch(()=>{if(active)setPolicyError(true);});
    return()=>{active=false;controller.abort();};
  },[policyRead]);
  useEffect(() => { if (state.error) feedback.current?.focus(); }, [state.error]);
  useEffect(() => {
    if (state.status !== 'ready' || state.pending || !state.payments.some(p => p.status !== 'SUCCEEDED') || pollCount.current >= 40) return;
    const timer = setTimeout(() => { if (document.visibilityState === 'visible') { pollCount.current++; store.refresh(); } }, 3000);
    return () => clearTimeout(timer);
  }, [store, state.status, state.pending, state.payments]);
  const busy = state.requestState === 'sending', ready = state.status === 'ready', agreement = state.agreement;
  const canStart = ready && policy && agreement?.effectiveStatus === 'ACTIVE' && !state.payments.length && !state.pending && !state.storageError && !busy;
  const reservePath = `/events/${eventId}/shows/${showId}/reserve`;
  return <main id="main" className="discovery-page checkout-page">
    <Link className="programme-back" to={reservePath}>Back to seats & holds</Link>
    <header className="checkout-heading"><div><p className="eyebrow">SEATLEDGER / BOX OFFICE</p><h1 tabIndex="-1">Make it<br /><em>an evening.</em></h1>
      <p className="checkout-subtitle">{map?.event.title || 'Your saved seat agreement'}</p>
      {map && <p className="checkout-venue">{map.show.venue.name} / {map.show.venue.city}<br /><time dateTime={map.show.startsAt}>{venueWhen(map.show)}</time></p>}</div>
      <div className="checkout-step"><span>02 / CHECKOUT</span><p>A place in the room.<br />An outcome you can check.</p></div></header>
    <div className="checkout-demo"><strong>SIMULATED PAYMENT</strong><span>No card details. No real money is charged.</span></div>
    <div className="checkout-policy">{policy?<p>Current demo cancellation policy: cancel the whole booking for a full simulated refund strictly before {policy.cutoffMinutes} minutes ahead of show time, provided no ticket has been admitted. Cancellation releases the seats; the refund is processed separately. Current server policy applies when cancellation is requested.</p>
      :<p role="status">{policyError?'Cancellation policy could not be checked. Starting a new payment is paused.':'Checking the current cancellation policy.'}</p>}
      {policyError&&<button className="text-button" onClick={()=>setPolicyRead(n=>n+1)}>Retry policy check</button>}</div>
    <div className="checkout-grid"><section className="checkout-story" aria-labelledby="checkout-outcome">
      <div className="checkout-section-label"><span>PAYMENT & BOOKING</span><button className="text-button" disabled={busy || state.status === 'loading'} onClick={() => store.refresh()}>Check status</button></div>
      <h2 id="checkout-outcome">{state.pending ? 'Let’s recover your request.' : state.payments.length ? 'The latest from the box office.' : 'One last look.'}</h2>
      {state.status === 'loading' && <p role="status">Checking your saved hold and payment history.</p>}
      {(state.error || state.storageError) && <div className="checkout-alert" role="alert" tabIndex="-1" ref={feedback}><p>{state.error ? message(state.error) : 'Recovery storage is unavailable. New payment requests are paused.'}</p>
        {[401, 403].includes(state.error?.status) && <button className="secondary-button" onClick={() => auth.refresh()}>Check session</button>}</div>}
      {state.notice && <p className="checkout-notice" role="status">{state.notice}</p>}
      {state.pending && <div className="checkout-recovery"><p className="eyebrow">ORIGINAL REQUEST SAVED IN THIS TAB</p>
        <p>{busy ? 'Confirming the original request.' : 'Its response was not confirmed. Retry keeps the same request reference. A status read does not close an in-flight request.'}</p>
        <button className="primary-button" disabled={busy} onClick={() => store.retry()}>{busy ? 'Checking request…' : 'Retry original request'}</button>
        {!resolveConfirm ? <button className="text-button" disabled={busy} onClick={() => setResolveConfirm(true)}>Resolve original request instead</button>
          : <div className="checkout-resolve"><p>If it already completed, recover its saved result. Otherwise close that exact request so it cannot start later. Existing payments continue; this does not cancel or refund them.</p>
            <button className="secondary-button" disabled={busy} onClick={() => { setResolveConfirm(false); store.resolve(); }}>Yes, resolve this request</button>
            <button className="quiet-button" disabled={busy} onClick={() => setResolveConfirm(false)}>Keep retrying</button></div>}
      </div>}
      {ready && !state.payments.length && <p className="checkout-explanation">{agreement.effectiveStatus === 'ACTIVE'
        ? 'Review the saved seats and total. Starting this demonstration asks the server to process one simulated payment for this hold.'
        : `This hold is ${agreement.effectiveStatus.toLowerCase()} and cannot start a new payment. Its payment history is shown when available.`}</p>}
      {ready && state.payments.map(payment => { const outcome = paymentOutcome(payment); return <article key={payment.id} className={`checkout-outcome outcome-${outcome.tone}`} aria-live="polite">
        <p className="eyebrow">SIMULATED / {payment.status}</p><h3>{outcome.title}</h3><p>{outcome.detail}</p>
        <dl><div><dt>Saved amount</dt><dd>{priceLabel(payment.amountMinor, payment.currency)}</dd></div><div><dt>Payment reference</dt><dd><code>{payment.id}</code></dd></div>
          {payment.bookingId && <div><dt>Booking reference</dt><dd><Link to={'/account/bookings/'+payment.bookingId}>View saved booking receipt</Link><br/><code>{payment.bookingId}</code></dd></div>}</dl>
        {payment.resolution === 'REFUND_REQUIRED' && <RefundStatus key={payment.id} payment={payment} />}
      </article>; })}
      {ready && state.payments.length > 1 && <p className="checkout-alert">Multiple attempts need review. New payment requests are paused.</p>}
      {ready && !!state.payments.length && <p className="checkout-small">Unfinished outcomes refresh every three seconds, up to 40 checks in this visit. Check status or return to this address at any time. A failed attempt may still receive a delayed success.</p>}
      <div className="checkout-footnote"><span aria-hidden="true">SL / 02</span><p>The server checks your original hold deadline and seat ownership. Opening checkout or starting payment does not add time.</p></div>
    </section><aside className="checkout-summary" aria-labelledby="checkout-summary"><p className="eyebrow">YOUR SAVED AGREEMENT</p><h2 id="checkout-summary">The details.</h2>
      {agreement ? <><ol>{agreement.items.map((item, index) => { const seat = map?.seats.find(s => s.id === item.id); return <li key={item.id}><div><strong>{seat ? `${seat.section} / row ${seat.row}, seat ${seat.number}` : `Seat ${index + 1}`}</strong>{!seat && <small>Reference {item.id}</small>}</div><span>{priceLabel(item.priceMinor, item.currency)}</span></li>; })}</ol>
        <div className="checkout-total"><span>Saved total</span><strong>{priceLabel(agreement.totalMinor, agreement.currency)}</strong></div>
        <p className="checkout-small">Original hold deadline<br /><time dateTime={agreement.expiresAt}>{utcWhen(agreement.expiresAt)}</time></p>
        <button className="primary-button" disabled={!canStart} onClick={() => store.start()}>{busy ? 'Confirming request…' : state.payments.length ? 'Payment already started' : 'Start simulated payment'}</button>
      </> : <p className="checkout-small">Your saved seats and amount appear after the server confirms this agreement.</p>}
      <p className="checkout-small">Keep this page address to recover this agreement and check refund progress. Find confirmed tickets in Your bookings.</p>
      <details className="checkout-reference"><summary>Hold reference</summary><code>{reservationId}</code></details>
    </aside></div>
  </main>;
}
