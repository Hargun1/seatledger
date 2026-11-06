import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { remainingLabel } from '../reservations/model.js';
import { createAssistantStore } from './store.js';
import './assistant.css';

const price = (minor, currency) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
const when = card => new Intl.DateTimeFormat('en-IN', { timeZone: card.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(card.startsAt));
const starters = [
  { label: 'Comedy in Bengaluru', text: 'Find comedy in Bengaluru. I need two adjacent seats under ₹1,500 total.' },
  { label: 'Music this weekend', text: 'Find music events in Bengaluru this weekend. I need two seats.' },
  { label: 'An evening under ₹1,500', text: 'Find events in Bengaluru with two seats under ₹1,500 total.' }
];
function ShowMeta({ card }) {
  return <div className="assistant-show-meta"><p>{card.venue} · {card.city}</p><p><time dateTime={card.startsAt}>{when(card)}</time><span>{card.timezone}</span></p></div>;
}
function SeatList({ seats }) {
  return <ul className="assistant-seats">{seats.map(seat => <li key={seat.id}><span><strong>{seat.row}{seat.number}</strong><span>{seat.section} · Row {seat.row} · Seat {seat.number}</span></span><b>{price(seat.priceMinor, seat.currency)}</b></li>)}</ul>;
}
function Card({ card, index, active, disabled, send }) {
  const eventNumber = card.offerNumber || index + 1, optionNumber = card.optionNumber || index + 1;
  if (card.type === 'event') return <article className="assistant-card">
    <div className="assistant-card-top"><span className="assistant-tag">{card.category}</span><span className="assistant-option-label">Show {eventNumber}</span></div>
    <h3>{card.title}</h3><ShowMeta card={card} />
    <p className="assistant-price">{card.fromTotalMinor === null ? 'No matching seats' : <><strong>{price(card.fromTotalMinor, card.currency)}</strong><span>from · {card.ticketCount} {card.ticketCount === 1 ? 'seat' : 'seats'} total</span></>}</p>
    <div className="assistant-card-actions">{active && <button className="secondary-button" disabled={disabled} onClick={() => send(`Recommend seats for event ${eventNumber}.`)}>Check seats for event {eventNumber}<span aria-hidden="true">→</span></button>}
      <Link to={`/events/${card.eventId}`}>Event details ↗</Link></div>
  </article>;
  if (card.type === 'seats') return <article className="assistant-card">
    <div className="assistant-card-top"><span className="assistant-tag">{card.adjacent ? 'Seated together' : 'Separate seats'}</span><span className="assistant-option-label">Option {optionNumber}</span></div>
    <h3>{card.title}</h3><SeatList seats={card.seats} /><p className="assistant-price"><strong>{price(card.totalMinor, card.currency)}</strong><span>{card.seats.length} seats · total</span></p>
    {active && <button className="secondary-button" disabled={disabled} onClick={() => send(`Prepare a booking summary for seat option ${optionNumber}.`)}>Review seat option {optionNumber}<span aria-hidden="true">→</span></button>}
  </article>;
  if (card.type === 'proposal') return <div className="assistant-ready-note"><span aria-hidden="true">✓</span><div><strong>{active ? 'Your seat selection is ready to review.' : 'A booking summary was prepared.'}</strong>
    {active && <a href="#assistant-booking-details">Review booking details →</a>}</div></div>;
  if (card.type === 'availability') return <article className="assistant-card"><h3>{card.title}</h3><p>{card.availableCount} seats currently available. Ask for a seat recommendation to check your group.</p></article>;
  if (card.type === 'status') return <article className="assistant-card"><h3>Reservation update</h3><p>{card.effectiveStatus.toLowerCase()} · {price(card.totalMinor, card.currency)}</p>
    {card.bookingPath && <Link to={card.bookingPath}>View saved booking</Link>}</article>;
  return <div className="assistant-ready-note"><span aria-hidden="true">✓</span><div><strong>Your hold was saved.</strong><a href="#assistant-booking-details">View current hold →</a></div></div>;
}
function Progress({ step }) {
  return <ol className="assistant-progress" aria-label="Booking steps">{['Find a show','Choose seats','Review & hold','Checkout'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} className={step > index + 1 ? 'complete' : ''}>
    <span aria-hidden="true">{step > index + 1 ? '✓' : index + 1}</span><span>{label}</span></li>)}</ol>;
}
function BookingDetails({ conversation, disabled, busy, remaining, estimatedNow, confirm, refresh, fill }) {
  const hold = conversation?.hold, proposal = conversation?.proposal;
  const currentHold = hold && ['ACTIVE','CONFIRMED'].includes(hold.effectiveStatus);
  const expired = proposal && (proposal.status === 'EXPIRED' || Date.parse(proposal.expiresAt) <= estimatedNow);
  const preferences = conversation?.preferences;
  const hasSearch = conversation?.messages.some(message => message.role === 'user');
  return <aside className="assistant-plan" aria-label="Booking details">
    <header><p className="eyebrow">YOUR EVENING</p><h2 id="assistant-booking-details" tabIndex="-1">Booking details</h2></header>
    {currentHold ? <section className="assistant-current-hold" aria-label="Current seat hold">
      <span className="assistant-tag">{hold.effectiveStatus === 'CONFIRMED' ? 'Booking saved' : 'Seats held for you'}</span><h3>{hold.title}</h3>
      <p className="assistant-price"><strong>{price(hold.totalMinor, hold.currency)}</strong><span>{hold.items.length} {hold.items.length === 1 ? 'seat' : 'seats'} · total</span></p>
      {hold.effectiveStatus === 'ACTIVE' && <>
        <div className="assistant-countdown">{remaining === 'Check expiry' ? <p>The hold may have expired. Check its saved status.</p> : <><span>Time remaining:</span><strong>{remaining}</strong><span>Complete checkout before the timer ends.</span></>}</div>
        {remaining !== 'Check expiry' && <Link className="primary-link" to={hold.checkoutPath}>Review & start simulated payment <span aria-hidden="true">↗</span></Link>}
        <p className="assistant-caption">No payment has been authorized by the assistant. Review and authorize it in checkout.</p>
      </>}
      {hold.bookingPath && <Link className="primary-link" to={hold.bookingPath}>View saved booking receipt</Link>}
      <button className="quiet-button" disabled={busy} onClick={refresh}>Check hold status</button>
    </section> : proposal && proposal.status !== 'CONFIRMED' ? <section className="assistant-summary" aria-label="Booking summary">
      <span className="assistant-tag">{expired ? 'Summary expired' : 'Ready for your review'}</span><h3>{proposal.title}</h3><ShowMeta card={proposal} /><SeatList seats={proposal.seats} />
      <p className="assistant-price"><strong>{price(proposal.totalMinor, proposal.currency)}</strong><span>total / simulated payment</span></p>
      {expired ? <><p>This summary has expired. Get fresh seat options before holding.</p><button className="secondary-button" disabled={disabled} onClick={() => fill('Recommend seats again for the same event.')}>Find fresh seats</button></>
        : <><div className="assistant-confirm-note"><strong>No seats held yet.</strong><p>Confirm to hold these seats for five minutes. You’ll authorize payment separately in checkout.</p></div>
          <button className="primary-button" disabled={disabled} onClick={() => confirm(proposal)}>Confirm hold · {price(proposal.totalMinor, proposal.currency)}<span aria-hidden="true">→</span></button>
          <p className="assistant-caption">Summary valid until {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' }).format(new Date(proposal.expiresAt))} IST. Availability is checked again when you confirm.</p></>}
    </section> : <>
      {hold && <div className="assistant-expired"><strong>{hold.effectiveStatus === 'EXPIRED' ? 'Your previous hold expired.' : 'Your previous hold was released.'}</strong><p>Choose fresh seats when you’re ready.</p><button className="quiet-button" disabled={busy} onClick={refresh}>Check hold status</button></div>}
      <div className="assistant-plan-empty"><div className="assistant-seat-mark" aria-hidden="true">▱</div><h3>{hasSearch ? 'Your plans are taking shape.' : 'Your next evening starts here.'}</h3><p>{hasSearch ? 'Choose a show, then review a seat option. Your selection and total will appear here before you confirm.' : 'Tell us what you’d like to see. We’ll help you find a show and seats that fit.'}</p></div>
      {hasSearch && preferences && <div className="assistant-search-summary"><h3>Your current search</h3><dl>
        {preferences.city && <div><dt>City</dt><dd>{preferences.city}</dd></div>}{preferences.category && <div><dt>Category</dt><dd>{preferences.category}</dd></div>}
        <div><dt>Seats</dt><dd>{preferences.ticketCount}{preferences.adjacent ? ' · together' : ''}</dd></div>
        {preferences.budgetMinor !== null && <div><dt>Budget</dt><dd>Up to {price(preferences.budgetMinor, 'INR')} {preferences.budgetScope === 'per_ticket' ? 'per seat' : 'total'}</dd></div>}
      </dl><p className="assistant-caption">Change your preferences in the chat at any time.</p></div>}
      <ul className="assistant-assurances"><li>You review every seat and price.</li><li>A hold lasts five minutes.</li><li>Payments are simulated. No real money.</li></ul>
    </>}
  </aside>;
}

export function Assistant() {
  const auth = useAuth(), userId = auth.session.user.id, csrfToken = auth.session.csrfToken;
  const store = useMemo(() => createAssistantStore({ userId, csrfToken }), [userId, csrfToken]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [draft, setDraft] = useState(''), [clock, setClock] = useState(() => performance.now());
  const log = useRef(null), latest = useRef(null), errorRef = useRef(null), composer = useRef(null), form = useRef(null);
  const conversation = state.conversation, disabled = state.busy || Boolean(state.pending) || Boolean(conversation?.busy);
  const lastAssistant = conversation?.messages.findLast(message => message.role === 'assistant');
  useEffect(() => { document.title = 'SeatLedger - AI booking assistant'; store.open(); return store.cancel; }, [store]);
  useEffect(() => { const timer = setInterval(() => setClock(performance.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (state.error) errorRef.current?.focus(); }, [state.error]);
  useEffect(() => { if ([401,403].includes(state.error?.status)) auth.refresh(); }, [state.error]);
  useEffect(() => {
    if (!log.current) return;
    log.current.scrollTo({ top: state.busy || conversation?.busy ? log.current.scrollHeight : Math.max(0, (latest.current?.offsetTop || 0) - 16), behavior: 'instant' });
  }, [conversation?.revision, state.busy, conversation?.busy]);
  useEffect(() => {
    if (!conversation?.busy) return;
    let reads = 0; const timer = setInterval(() => { if (++reads <= 45) store.refresh(); else clearInterval(timer); }, 2000);
    return () => clearInterval(timer);
  }, [conversation?.busy, store]);
  const hold = conversation?.hold, remaining = hold && remainingLabel(hold.expiresAt, conversation.serverNow, state.observedAt, clock);
  const estimatedNow = conversation ? Date.parse(conversation.serverNow) + Math.max(0, clock - state.observedAt) : Date.now();
  const step = hold && ['ACTIVE','CONFIRMED'].includes(hold.effectiveStatus) ? 4 : conversation?.proposal?.status === 'READY' && Date.parse(conversation.proposal.expiresAt) > estimatedNow ? 3 : lastAssistant?.cards.some(card => card.type === 'seats') ? 2 : 1;
  const started = conversation?.messages.some(message => message.role === 'user');
  const fill = message => { setDraft(message); composer.current?.focus(); };
  const send = async message => { await store.send(message); composer.current?.focus({ preventScroll: true }); };
  async function submit(event) { event.preventDefault(); if (disabled || !draft.trim()) return; const message = draft; setDraft(''); await send(message); }
  return <main id="main" className="assistant-page">
    <header className="assistant-intro"><div><p className="eyebrow">YOUR AI BOOKING ASSISTANT</p><h1 tabIndex="-1">Find your next <em>good evening.</em></h1><p>Tell us what you have in mind. We’ll help you find the show and the seats.</p></div><Link to="/events">Browse all events <span aria-hidden="true">↗</span></Link></header>
    <Progress step={step} />
    <div className="assistant-layout">
      <section className="assistant-room" aria-label="Booking assistant">
        <div className="assistant-toolbar"><div className="assistant-agent"><span aria-hidden="true">✦</span><div><h2>Let’s plan your evening</h2><p>Search shows, compare seats, then confirm.</p></div></div>
          {conversation && <button className="quiet-button" disabled={state.busy || conversation.busy} onClick={store.startNew}>New conversation</button>}</div>
        {state.phase === 'loading' && <div className="assistant-empty" role="status"><span className="assistant-loading-dot" aria-hidden="true" /><h3>Opening your conversation…</h3><p>Getting your saved plans ready.</p></div>}
        {state.phase === 'disabled' && <div className="assistant-empty"><div className="assistant-seat-mark" aria-hidden="true">✦</div><h3>The assistant is getting ready.</h3><p>You can still find a show and choose seats through the programme.</p><Link className="primary-link" to="/events">Find events & choose seats <span aria-hidden="true">→</span></Link></div>}
        {state.error && <div className="form-error" ref={errorRef} tabIndex="-1" role="alert"><p>{state.error.message}</p><button className="secondary-button" disabled={state.busy} onClick={conversation ? store.refresh : store.open}>Check conversation</button>
          {state.error.code === 'NOT_FOUND' && <button className="quiet-button" disabled={state.busy} onClick={store.startNew}>Start a new conversation</button>}</div>}
        {conversation && <>
          <div ref={log} className="assistant-messages" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text" tabIndex="0">
            {conversation.historyTruncated && <p className="assistant-caption">Earlier messages were trimmed. Your current preferences and saved hold are retained.</p>}
            {conversation.messages.map(message => {
              const active = message.id === lastAssistant?.id;
              const cards = message.cards.map((card, index) => <Card key={card.optionRef || card.offerRef || card.id || index} card={card} index={index} active={active} disabled={disabled} send={send} />);
              return <div key={message.id} ref={active ? latest : undefined} className={'assistant-message ' + message.role}>
                <p className="assistant-speaker">{message.role === 'user' ? 'You' : 'SeatLedger'}</p><p className="assistant-message-text">{message.text}</p>
                {message.truncated && <p className="assistant-caption">Showing a selection of results. Narrow the city or date to see more.</p>}
                {!!cards.length && (active ? <div className="assistant-cards">{cards}</div> : <details className="assistant-history"><summary>View previous recommendations</summary><div className="assistant-cards">{cards}</div></details>)}
              </div>;
            })}
            {!started && <div className="assistant-starters"><h3>Need a starting point?</h3><p>Pick an idea, then make it your own.</p><div>{starters.map(starter => <button key={starter.label} disabled={disabled} onClick={() => fill(starter.text)}>{starter.label}<span aria-hidden="true">↗</span></button>)}</div></div>}
            {state.pending?.action === 'message' && <div className="assistant-message user"><p className="assistant-speaker">Your saved request</p><p className="assistant-message-text">{state.pending.body.message}</p></div>}
            {(state.busy || conversation.busy) && <p className="assistant-thinking" role="status"><span className="assistant-loading-dot" aria-hidden="true" />Checking shows and seats…</p>}
          </div>
          {state.pending && !state.busy && !conversation.busy && <div className="assistant-recovery"><strong>Let’s check your saved request.</strong><p>Check its outcome before trying again.</p><div><button className="secondary-button" onClick={store.refresh}>Check saved outcome</button>{state.checked && <button className="secondary-button" onClick={store.retry}>Retry saved {state.pending.action === 'confirm' ? 'confirmation' : 'message'}</button>}</div></div>}
          <form ref={form} className="assistant-composer" onSubmit={submit} aria-busy={state.busy}>
            {started && !hold && <div className="assistant-refinements" aria-label="Conversation shortcuts"><button type="button" disabled={disabled} onClick={() => fill('Show cheaper options with the same search preferences.')}>Cheaper options</button><button type="button" disabled={disabled} onClick={() => fill('Recommend adjacent seats for the same event.')}>Seats together</button></div>}
            <label htmlFor="assistant-message">What would you like to see?</label>
            <div className="assistant-input-row"><textarea id="assistant-message" ref={composer} value={draft} onChange={event => setDraft(event.target.value)} maxLength={1500} rows={2} aria-describedby="assistant-input-help"
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); form.current?.requestSubmit(); } }}
              disabled={disabled} placeholder="Two comedy tickets in Bengaluru under ₹1,500 total…" /><button className="primary-button" disabled={disabled || !draft.trim()}>Send message <span aria-hidden="true">↗</span></button></div>
            <p id="assistant-input-help" className="assistant-input-help">Enter to send · Shift + Enter for a new line <span>India time · Simulated payments</span></p>
            <p className="assistant-privacy">Messages go to the AI provider. Keep passwords and payment details private.</p>
          </form>
        </>}
      </section>
      <BookingDetails conversation={conversation} disabled={disabled} busy={state.busy} remaining={remaining} estimatedNow={estimatedNow} confirm={store.confirm} refresh={store.refresh} fill={fill} />
    </div>
  </main>;
}
