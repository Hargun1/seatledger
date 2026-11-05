import React, { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { seatingSections, priceLabel, stateLabels, venueWhen, utcWhen } from '../discovery/model.js';
import { DiscoveryError } from '../discovery/client.js';
import { BookingError } from './client.js';
import { createBookingStore } from './store.js';
import { remainingLabel } from './model.js';
import './booking.css';

const message = error => error instanceof BookingError || error instanceof DiscoveryError ? error.message : 'We could not check this information. Please try again.';
const seatName = seat => `${seat.section}, row ${seat.row}, seat ${seat.number}`;
function itemName(id, map) { const seat = map?.seats.find(s => s.id === id); return seat ? seatName(seat) : `Seat reference ${id}`; }

const SelectablePlan = memo(function SelectablePlan({ seats, selected, holds, enabled, onSelect, conflicts }) {
  const owned = new Set(holds.flatMap(h => h.items.map(i => i.id)));
  return seatingSections(seats).map(section => <section className="programme-seating-section" key={section.id} aria-labelledby={`booking-${section.id}`}>
    <div className="programme-section-heading"><h2 id={`booking-${section.id}`}>{section.name}</h2><span>CHOOSE UP TO 8</span></div>
    <div className="programme-seat-scroll" role="region" tabIndex="0" aria-label={`${section.name} seating; wide rows scroll horizontally`}>
      <div className="programme-seat-layout"><p className="programme-stage">STAGE / SCHEMATIC VIEW</p>
        {section.rows.map(row => <div className="programme-seat-row" key={row.label}><span className="programme-row-label" aria-hidden="true">{row.label}</span>
          <ol aria-label={`Row ${row.label}`}>{row.cells.map(seat => {
            const chosen = selected.includes(seat.id), ours = owned.has(seat.id);
            const label = ours ? 'Your hold' : chosen ? 'Selected' : seat.state === 'HELD' ? 'Held / check' : stateLabels[seat.state];
            return <li key={seat.id}><button type="button" className={`booking-seat programme-seat seat-${seat.state.toLowerCase()}${chosen ? ' is-selected' : ''}${ours ? ' is-owned' : ''}${conflicts.includes(seat.id) ? ' was-unavailable' : ''}`}
              disabled={!enabled || seat.state === 'BOOKED' || ours} aria-pressed={chosen} onClick={() => onSelect(seat.id)}
              aria-label={`${seatName(seat)}: ${label}. ${priceLabel(seat.priceMinor, seat.currency)}${conflicts.includes(seat.id) ? '. Unavailable in the last request' : ''}`}>
              <span className="seat-number" aria-hidden="true">{seat.number}</span><span className="seat-state" aria-hidden="true">{label}</span>
              <span className="seat-price" aria-hidden="true">{priceLabel(seat.priceMinor, seat.currency)}</span>
            </button></li>;
          })}</ol></div>)}
      </div>
    </div>
  </section>);
});

function Holds({ state, store, disabled, eventId, showId }) {
  const [now, setNow] = useState(() => performance.now()), [confirm, setConfirm] = useState(null);
  const releaseButtons = useRef(new Map()), restoreFocus = useRef(null);
  useEffect(() => { if (confirm === null && restoreFocus.current) { releaseButtons.current.get(restoreFocus.current)?.focus(); restoreFocus.current = null; } }, [confirm]);
  useEffect(() => {
    setNow(performance.now());
    if (!state.holds.length) return;
    const timer = setInterval(() => setNow(performance.now()), 1000); return () => clearInterval(timer);
  }, [state.holds, state.observedAt]);
  const expiredDisplay = state.holds.some(h => remainingLabel(h.expiresAt, state.asOf, state.observedAt, now) === 'Check expiry');
  return <section className="booking-holds" aria-labelledby="your-holds">
    <div className="programme-section-heading"><h2 id="your-holds">Your current holds.</h2><span>{state.holds.length} ON THIS READ</span></div>
    <p className="programme-caption">These agreements were confirmed by the server at the last read. Time remaining is approximate; a hold is not a ticket. Refresh to check the current position.</p>
    {state.status === 'loading' ? <p role="status">Checking your holds.</p> : state.holdsError ? <p role="alert">{message(state.holdsError)}</p>
      : !state.holds.length ? <p className="booking-empty">No complete live holds were found for this show at this read.</p>
        : <ol className="booking-hold-list">{state.holds.map(hold => <li key={hold.id}>
          <div className="booking-hold-top"><div><p className="eyebrow">SERVER-SAVED HOLD / CHECK PAYMENT</p><h3>{hold.items.length} {hold.items.length === 1 ? 'seat' : 'seats'} for this evening</h3></div>
            <div className="booking-countdown" aria-live="off"><strong>{remainingLabel(hold.expiresAt, state.asOf, state.observedAt, now)}</strong><span>APPROX. REMAINING</span></div></div>
          <ul>{hold.items.map(item => <li key={item.id}><span>{itemName(item.id, state.map)}</span><span>{priceLabel(item.priceMinor, item.currency)}</span></li>)}</ul>
          <div className="booking-hold-total"><span>Saved total</span><strong>{priceLabel(hold.totalMinor, hold.currency)}</strong></div>
          <p className="booking-deadline">Deadline: <time dateTime={hold.expiresAt}>{utcWhen(hold.expiresAt)}</time>. The server makes the final expiry decision.</p>
          <details className="booking-reference"><summary>Hold reference</summary><code>{hold.id}</code></details>
          {!disabled && <Link className="checkout-link" to={`/events/${eventId}/shows/${showId}/checkout/${hold.id}`}>Review & start simulated payment</Link>}
          {confirm === hold.id ? <div className="booking-release-confirm"><p>Release this entire hold? Its seats may be taken by someone else.</p>
            <button className="secondary-button" disabled={disabled} onClick={() => { setConfirm(null); store.release(hold.id); }}>Yes, release seats</button>
            <button className="quiet-button" disabled={disabled} onClick={() => { restoreFocus.current = hold.id; setConfirm(null); }}>Keep this hold</button></div>
            : <button className="text-button" ref={node => { if (node) releaseButtons.current.set(hold.id, node); else releaseButtons.current.delete(hold.id); }} disabled={disabled} onClick={() => setConfirm(hold.id)}>Release this hold</button>}
        </li>)}</ol>}
    <p className="booking-expiry-note" role="status">{expiredDisplay ? 'A displayed deadline has passed. Refresh holds to check the server; the display does not release seats.' : ''}</p>
    <p className="booking-payment-note">SIMULATED PAYMENTS ONLY. Open checkout to check this hold's payment outcome. A hold is not a paid booking; no real money is charged.</p>
  </section>;
}

export function Booking() {
  const { eventId, showId } = useParams(), auth = useAuth();
  return <BookingRoom key={`${auth.session.user.id}:${eventId}:${showId}`} eventId={eventId.toLowerCase()} showId={showId.toLowerCase()} />;
}
function BookingRoom({ eventId, showId }) {
  const [resolveConfirm, setResolveConfirm] = useState(false);
  const auth = useAuth(), csrf = useRef(auth.session.csrfToken); csrf.current = auth.session.csrfToken;
  const store = useMemo(() => createBookingStore({ userId: auth.session.user.id, eventId, showId, getCsrf: () => csrf.current }), [auth.session.user.id, eventId, showId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot), feedback = useRef(null), pendingHeading = useRef(null);
  useEffect(() => {
    store.refresh(); const refresh = () => { if (document.visibilityState === 'visible') store.refresh(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { store.cancel(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [store]);
  useEffect(() => { document.title = `SeatLedger - ${state.map?.event.title || 'Choose your seats'}`; }, [state.map?.event.title]);
  useEffect(() => { if (state.feedback || state.error) feedback.current?.focus(); }, [state.feedback, state.error]);
  useEffect(() => { if (state.pending && !state.error) pendingHeading.current?.focus(); }, [state.pending, state.requestState, state.error]);
  const sending = state.requestState === 'sending', disabled = sending || state.status === 'loading' || Boolean(state.pending) || state.storageError;
  const enabled = !disabled && !state.holdsError, picked = state.map?.seats.filter(s => state.selected.includes(s.id)) || [];
  return <main id="main" className="discovery-page booking-page">
    <Link className="programme-back" to={`/events/${eventId}/shows/${showId}/seats`}>Back to the seating preview</Link>
    <header className="booking-heading"><div><p className="eyebrow">SEATLEDGER / MAKE YOUR EVENING</p><h1 tabIndex="-1">A place<br />for <em>you.</em></h1>
      {state.map ? <><h2>{state.map.event.title}</h2><p>{state.map.show.venue.name} / {state.map.show.venue.city}</p><p><time dateTime={state.map.show.startsAt}>{venueWhen(state.map.show)}</time> / {state.map.show.venue.timezone}</p></> : <p>Choose seats, then ask the server to hold them for five minutes.</p>}</div>
      <div className="booking-reading"><span className="eyebrow">01 / CHOOSE & HOLD</span><p>Selection is a request.<br />Your place is held only after the server confirms it.</p><button className="secondary-button" disabled={sending || state.status === 'loading'} onClick={() => store.refresh()}>Refresh seats & holds</button></div></header>
    {(state.feedback || state.error) && <div className="booking-feedback" tabIndex="-1" ref={feedback} role={state.error ? 'alert' : 'status'}>
      {state.error && <p>{message(state.error)}</p>}{state.feedback && <p>{state.feedback}</p>}
      {[state.error, state.holdsError].some(e => [401, 403].includes(e?.status)) && <button className="secondary-button" onClick={() => auth.refresh()}>Check session</button>}
    </div>}
    {state.pending && <section className="booking-pending" aria-labelledby="request-heading"><p className="eyebrow">{sending ? 'REQUEST IN PROGRESS' : 'RESPONSE NOT CONFIRMED'}</p>
      <h2 id="request-heading" tabIndex="-1" ref={pendingHeading}>{sending ? 'Checking your request.' : 'Keep this request together.'}</h2>
      <p>{state.pending.kind === 'create' ? `A request to hold ${state.pending.seatIds.length} seat(s)` : 'A request to release a hold'} is saved in this tab for recovery. Do not start another request while its result is unconfirmed.</p>
      {!sending && <><p>Checking your current holds may help, but an empty read does not prove this request failed. Retrying keeps the same request reference.</p>
        <button className="primary-button" onClick={() => store.retry()}>Retry this request</button>
        {!resolveConfirm ? <button className="text-button" onClick={() => setResolveConfirm(true)}>Resolve saved request instead</button>
          : <div className="booking-release-confirm"><p>If the saved request already completed, we will read its result. Otherwise this closes that exact request so it cannot run later. This check does not release an existing hold.</p>
            <button className="secondary-button" onClick={() => { setResolveConfirm(false); store.resolve(); }}>Yes, resolve this request</button>
            <button className="quiet-button" onClick={() => setResolveConfirm(false)}>Keep retrying</button></div>}</>}
    </section>}
    <div className="booking-grid"><section className="booking-room" aria-labelledby="choose-seats"><div className="programme-section-heading"><h2 id="choose-seats">Find your place.</h2><span>SELECTION IS NOT A HOLD</span></div>
      {state.status === 'loading' && <p className="programme-loading" role="status">Reading the room and your saved holds.</p>}
      {state.mapError && <div className="programme-error" role="alert"><h3>The room could not be read.</h3><p>{message(state.mapError)}</p><p>Your own holds can still be checked below. Refresh to try the seating plan again.</p></div>}
      {state.map && <><p className="programme-caption">Viewing or selecting a seat does not reserve it. A seat marked Held / check can be selected to ask the server whether the old hold has expired; a live hold will be refused. Booked seats and your current holds cannot be selected. Wide rows scroll horizontally.</p>
        <ul className="programme-legend" aria-label="Seat states"><li><span className="legend-mark seat-available" aria-hidden="true" />Available</li><li><span className="legend-mark booking-selected-mark" aria-hidden="true" />Selected</li><li>Held / your hold</li><li>Booked</li></ul>
        <SelectablePlan seats={state.map.seats} selected={state.selected} holds={state.holds} enabled={enabled} onSelect={store.select} conflicts={state.conflicts} />
        <p className="programme-caption">Availability read at {utcWhen(state.map.asOf)}. Held seats may already have expired; the server decides when you request a hold. The map is schematic, not a sightline guarantee.</p></>}
    </section><aside className="booking-selection" aria-labelledby="selection-heading"><div className="booking-selection-inner"><p className="eyebrow">YOUR SELECTION / NOT YET HELD</p><h2 id="selection-heading">A small<br /><em>plan.</em></h2>
      <p className="booking-selected-count" role="status">{picked.length} of 8 seats selected</p>
      {picked.length ? <><ul>{picked.map(seat => <li key={seat.id}><span>{seatName(seat)}{seat.state === 'HELD' ? ' / check old hold' : ''}</span><strong>{priceLabel(seat.priceMinor, seat.currency)}</strong></li>)}</ul><div className="booking-estimate"><span>Displayed total</span><strong>{priceLabel(picked.reduce((n, seat) => n + seat.priceMinor, 0), picked[0].currency)}</strong></div></> : <p>Choose seats from the room. Held seats can be checked, but may still be unavailable. A hold is all of the selected seats, or none of them.</p>}
      <p className="programme-caption">The server checks availability and saves its current prices. This displayed total is an estimate.</p>
      <button className="primary-button" disabled={!enabled || !picked.length || !state.map} onClick={() => store.hold()}>{sending ? 'Sending request…' : 'Hold selected seats'}</button>
      {!!picked.length && <button className="text-button" disabled={!enabled} onClick={() => state.selected.forEach(store.select)}>Clear selection</button>}
      {state.storageError && <p role="alert">New requests are paused because this tab cannot keep its recovery reference. Allow storage for this tab, then reload to check again.</p>}
      <p className="booking-no-charge">NO CHARGE / NO TICKET YET</p></div></aside></div>
    <Holds state={state} store={store} disabled={disabled || Boolean(state.holdsError)} eventId={eventId} showId={showId} />
  </main>;
}
