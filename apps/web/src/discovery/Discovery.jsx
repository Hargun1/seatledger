import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { discoveryRequest, DiscoveryError } from './client.js';
import { createPublicReader } from './reader.js';
import { readSearch, searchFor, venueWhen, utcWhen, priceLabel, stateLabels, seatingSections } from './model.js';

function useProgramme(action, { eventId, showId, search = '' } = {}) {
  const reader = useMemo(() => createPublicReader(signal => discoveryRequest(action, { eventId, showId, search, signal })),
    [action, eventId, showId, search]);
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => { reader.refresh(); return reader.cancel; }, [reader]);
  return { ...state, refresh: reader.refresh };
}
function usePageTitle(title) { useEffect(() => { document.title = `SeatLedger - ${title}`; }, [title]); }

function ReadFeedback({ resource, inventory = false, clear }) {
  if (resource.status === 'loading') return <p className="programme-loading" role="status">{inventory ? 'Reading saved availability.' : 'Reading the programme.'}</p>;
  if (resource.status !== 'error') return null;
  const error = resource.error;
  return <div className="programme-error" role="alert"><h2>{error?.status === 404 ? 'This one is off the bill.' : 'A pause in the programme.'}</h2>
    <p>{error instanceof DiscoveryError ? error.message : 'The programme could not be loaded. Please try again.'}</p>
    <div className="programme-actions"><button className="secondary-button" onClick={resource.refresh}>Try again</button>{clear && <Link to={clear}>Clear filters</Link>}</div></div>;
}
function ProgrammePages({ cursor, nextCursor, filters = {}, onMove }) {
  const { pathname } = useLocation();
  return <nav className="programme-pagination" aria-label="Programme pages"><p>Up to 20 per page / reference order</p><div>
    {cursor && <Link onClick={onMove} to={{ pathname, search: searchFor(filters) }}>First page</Link>}
    {nextCursor && <Link onClick={onMove} to={{ pathname, search: searchFor(filters, nextCursor) }}>Next page <span aria-hidden="true">→</span></Link>}
  </div></nav>;
}
function ShowTime({ show }) {
  return <div className="programme-time"><time dateTime={show.startsAt}>{venueWhen(show)}</time>
    <span>{show.venue.timezone}</span><span className="programme-utc">{utcWhen(show.startsAt)}</span></div>;
}
function SearchForm({ initial, onApply, clear }) {
  const [error, setError] = useState(''), errorRef = useRef(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  function submit(e) {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget)), search = searchFor(fields);
    if (!readSearch(search).valid) { setError('Use real UTC dates from 2000 to 2100, with the end on or after the start. Check the text lengths too.'); return; }
    setError(''); onApply(search);
  }
  return <form className="programme-search" onSubmit={submit} noValidate aria-label="Find an event">
    <div className="programme-search-grid">
      <label className="programme-search-title">Search the bill<input name="q" type="search" defaultValue={initial.q || ''} maxLength={120} placeholder="An event title" /></label>
      <label>City<input name="city" defaultValue={initial.city || ''} maxLength={120} placeholder="Any city" /></label>
      <label>Category<input name="category" defaultValue={initial.category || ''} maxLength={60} placeholder="e.g. Music" /></label>
      <label>From / UTC<input name="from" type="date" min="2000-01-01" max="2100-12-31" defaultValue={initial.from || ''} aria-describedby="programme-date-hint" /></label>
      <label>To / UTC<input name="to" type="date" min="2000-01-01" max="2100-12-31" defaultValue={initial.to || ''} aria-describedby="programme-date-hint" /></label>
      <button className="primary-button" type="submit">Find events <span aria-hidden="true">→</span></button>
    </div>
    <div className="programme-filter-note"><p id="programme-date-hint">Both dates include the whole UTC day. Show times below use the venue's clock.</p><Link to={clear}>Clear filters</Link></div>
    {error && <p className="form-error" role="alert" tabIndex="-1" ref={errorRef}>{error}</p>}
  </form>;
}

export function Discovery() {
  const [params, setParams] = useSearchParams(), search = params.toString();
  const { pathname } = useLocation(), parsed = readSearch(search), resource = useProgramme('events', { search });
  const results = useRef(null), focusResults = useRef(false);
  usePageTitle('The local programme');
  useEffect(() => { if (resource.status === 'ready' && focusResults.current) { results.current?.focus(); focusResults.current = false; } }, [resource.status, resource.data]);
  return <main id="main" className="discovery-page" aria-busy={resource.status === 'loading'}>
    <header className="programme-intro"><div><p className="eyebrow">SEATLEDGER / THE LOCAL PROGRAMME</p><h1 tabIndex="-1">The local<br /><em>programme.</em></h1></div>
      <div className="programme-colophon"><p className="eyebrow">SMALL STAGES. GOOD COMPANY.</p><p>Live music, new ideas and a reason to put your phone away.</p><p className="programme-caption">Browse the programme, hold your seats for five minutes and continue to simulated checkout. No real money is charged.</p></div></header>
    <SearchForm key={search} initial={parsed.filters} clear={pathname} onApply={next => { focusResults.current = true; if (next === search) resource.refresh(); else setParams(next); }} />
    <section className="programme-list" aria-labelledby="programme-heading"><div className="programme-section-heading"><h2 id="programme-heading" tabIndex="-1" ref={results}>On the bill.</h2>
      {resource.status === 'ready' && <p role="status">{resource.data.items.length} {resource.data.items.length === 1 ? 'event' : 'events'} on this page</p>}</div>
      <ReadFeedback resource={resource} clear={pathname} />
      {resource.status === 'ready' && <>
        {!resource.data.items.length ? <div className="programme-empty"><h3>{parsed.cursor ? 'The end of this page.' : 'A little quiet here.'}</h3><p>There are no upcoming events for this search. Try another city, category or date range.</p><Link to={pathname}>See the whole programme</Link></div>
          : <ol className="programme-entries">{resource.data.items.map((event, index) => <li key={event.id}><Link className="programme-entry" to={`/events/${event.id}`}>
            <span className="programme-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <div className="programme-event-name"><p className="eyebrow">{event.category}</p><h3>{event.title}</h3><p>{event.nextShow.venue.name} / {event.nextShow.venue.city}</p></div>
            <div><ShowTime show={event.nextShow} /><span className="programme-entry-link">View programme <span aria-hidden="true">↗</span></span></div>
          </Link></li>)}</ol>}
        <ProgrammePages cursor={parsed.cursor} nextCursor={resource.data.nextCursor} filters={parsed.filters} onMove={() => { focusResults.current = true; }} />
      </>}
    </section>
    <aside className="programme-endnote"><span className="eyebrow">FOR THE PEOPLE BEHIND THE EVENING</span><Link to="/organizers">Organize an event <span aria-hidden="true">↗</span></Link></aside>
  </main>;
}

export function EventProgramme() {
  const { eventId } = useParams(), [params] = useSearchParams(), search = params.toString();
  const parsed = readSearch(search, true), resource = useProgramme('event', { eventId, search });
  const data = resource.data, heading = useRef(null), moveFocus = useRef(false);
  usePageTitle(data?.event.title || 'Event programme');
  useEffect(() => { if (resource.status === 'ready' && moveFocus.current) { heading.current?.focus(); moveFocus.current = false; } }, [resource.status, data]);
  return <main id="main" className="discovery-page programme-detail" aria-busy={resource.status === 'loading'}>
    <Link className="programme-back" to="/events">← All events</Link>
    <header className="programme-detail-heading"><p className="eyebrow">{data?.event.category || 'SEATLEDGER / EVENT PROGRAMME'}</p><h1 tabIndex="-1">{data?.event.title || 'The programme.'}</h1><p>Choose a performance, explore its seating plan and request a hold. Continue to simulated checkout from your saved hold.</p></header>
    <section aria-labelledby="performance-heading"><div className="programme-section-heading"><h2 id="performance-heading" tabIndex="-1" ref={heading}>Dates & places.</h2><span>VENUE-LOCAL TIMES</span></div>
      <ReadFeedback resource={resource} clear={search ? `/events/${eventId}` : undefined} />
      {resource.status === 'ready' && <>
        {!data.shows.items.length && <p className="programme-empty">No performances on this page. Return to the first page to check the current programme.</p>}
        <ol className="programme-performances">{data.shows.items.map(show => <li key={show.id}>
          <ShowTime show={show} /><div><h3>{show.venue.name}</h3><p>{show.venue.city}</p></div>
          <Link className="secondary-button" to={`/events/${eventId}/shows/${show.id}/seats`}>View seating <span aria-hidden="true">↗</span><span className="sr-only"> for {show.venue.name}, {venueWhen(show)}</span></Link>
        </li>)}</ol>
        <ProgrammePages cursor={parsed.cursor} nextCursor={data.shows.nextCursor} onMove={() => { moveFocus.current = true; }} />
      </>}
    </section>
  </main>;
}

function SeatingPlan({ seats }) {
  return seatingSections(seats).map(section => <section className="programme-seating-section" key={section.id} aria-labelledby={`section-${section.id}`}>
    <div className="programme-section-heading"><h2 id={`section-${section.id}`}>{section.name}</h2><span>{section.rows.reduce((sum, row) => sum + row.cells.length, 0)} SEATS</span></div>
    <div className="programme-seat-scroll" role="region" aria-label={`${section.name} seating; scroll horizontally for wide rows`} tabIndex="0">
      <div className="programme-seat-layout"><p className="programme-stage">STAGE / SCHEMATIC VIEW</p>
        {section.rows.map(row => <div className="programme-seat-row" key={row.label}><span className="programme-row-label" aria-hidden="true">{row.label}</span>
          <ol aria-label={`Row ${row.label}`}>{row.cells.map(seat => <li className={`programme-seat seat-${seat.state.toLowerCase()}`} key={seat.id}>
            <span className="seat-number" aria-hidden="true">{seat.number}</span><span className="seat-state" aria-hidden="true">{stateLabels[seat.state]}</span>
            <span className="seat-price" aria-hidden="true">{priceLabel(seat.priceMinor, seat.currency)}</span>
            <span className="sr-only">{section.name}, row {row.label}, seat {seat.number}: {stateLabels[seat.state]}. {priceLabel(seat.priceMinor, seat.currency)}.</span>
          </li>)}</ol></div>)}
      </div>
    </div>
  </section>);
}
export function PublicSeating() {
  const { eventId, showId } = useParams(), { search } = useLocation();
  const resource = useProgramme('seats', { eventId, showId, search }), data = resource.data;
  usePageTitle(data ? `${data.event.title} - Seating` : 'Seating preview');
  return <main id="main" className="discovery-page programme-detail" aria-busy={resource.status === 'loading'}>
    <Link className="programme-back" to={`/events/${eventId}`}>← Event programme</Link>
    <header className="programme-detail-heading programme-map-heading"><div><p className="eyebrow">SEATING PREVIEW / READ ONLY</p><h1 tabIndex="-1">{data?.event.title || 'A place in the room.'}</h1>
      {data && <><p>{data.show.venue.name} / {data.show.venue.city}</p><ShowTime show={data.show} /></>}</div>
      <div className="programme-map-actions"><button className="secondary-button" disabled={resource.status === 'loading'} onClick={resource.refresh}>Refresh availability</button>
        {data && <Link className="secondary-button" to={`/events/${eventId}/shows/${showId}/reserve`}>Choose seats & hold</Link>}</div></header>
    <ReadFeedback resource={resource} inventory />
    {resource.status === 'ready' && <>
      <div className="programme-map-note"><div><p className="eyebrow">YOUR VIEW OF THE ROOM</p><p>This is a saved availability snapshot. Viewing it does not hold a seat. Choose seats on the hold screen to request a reservation, then review your saved agreement at simulated checkout.</p></div>
        <p className="programme-snapshot">Read at <time dateTime={data.asOf}>{utcWhen(data.asOf)}</time><span>Availability can change. Expired holds may still be marked Held.</span></p></div>
      <ul className="programme-legend" aria-label="Seat states">{Object.entries(stateLabels).map(([state, label]) => <li key={state}><span className={`legend-mark seat-${state.toLowerCase()}`} aria-hidden="true" />{label} <span className="legend-count">{data.seats.filter(s => s.state === state).length}</span></li>)}</ul>
      <p className="programme-caption">Each seat shows its saved price and currency. Wide rows scroll horizontally; focus the seating region and use the arrow keys. The schematic shows rows and numbers, not exact sightlines or distances.</p>
      <SeatingPlan seats={data.seats} />
      <p className="programme-map-footnote">All payments are simulated. Open Choose seats & hold to request a reservation. After a confirmed payment, open your saved booking receipt to issue admission tickets.</p>
    </>}
  </main>;
}
