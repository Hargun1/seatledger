import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Feedback, Pagination, WorkspaceHeading } from '../organizers/Workspace.jsx';
import { OrganizationNav } from '../organizers/OrganizationNav.jsx';
import { createWorkspaceStore } from '../organizers/workspace-store.js';
import { venueRequest } from '../venues/client.js';
import { showRequest, ShowError, settleInScope } from './client.js';
import { wallMinute, minuteInstant, resolveWallTime, priceInput, money, showPayload, venueTime } from './model.js';

function useShows(organizationId, eventId, showId) {
  const auth = useAuth(), userId = auth.session.user.id, csrfToken = auth.session.csrfToken;
  const store = useMemo(() => createWorkspaceStore({
    load: async options => {
      const data = await showRequest(showId ? 'detail' : 'list', { ...options, organizationId, eventId, showId });
      if (!showId) return data;
      const venue = await venueRequest('detail', { ...options, organizationId, venueId: data.venueId });
      if (!venue.hasShows || venue.organization.role !== data.organization.role) throw new ShowError('INVALID_RESPONSE');
      return { ...data, venue };
    },
    write: (action, body) => showRequest(action, { organizationId, eventId, showId, venueId: store.getSnapshot().page?.venueId, body, csrfToken }), onAuthRequired: auth.refresh
  }), [organizationId, eventId, showId, userId, csrfToken, auth.refresh]);
  const activeStore = useRef(null);
  useLayoutEffect(() => { activeStore.current = store; return () => { activeStore.current = null; }; }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { store.refresh(); return store.cancel; }, [store]);
  return { ...state, refresh: store.refresh, mutate: (...args) => settleInScope(() => store.mutate(...args), () => activeStore.current === store), recover: auth.refresh };
}
function useVenueRead(organizationId, venueId, detail = false) {
  const auth = useAuth(), userId = auth.session.user.id, csrf = auth.session.csrfToken;
  const store = useMemo(() => createWorkspaceStore({
    load: options => detail && !venueId ? Promise.resolve(null) : venueRequest(detail ? 'detail' : 'list', { ...options, organizationId, venueId }),
    write: () => { throw new ShowError('INVALID_REQUEST', 400); }, onAuthRequired: auth.refresh
  }), [organizationId, venueId, detail, userId, csrf, auth.refresh]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { store.refresh(); return store.cancel; }, [store]);
  return { ...state, refresh: store.refresh, recover: auth.refresh };
}

function VenuePicker({ organizationId, onSelected, busy }) {
  const [selectedId, setSelectedId] = useState(null);
  const list = useVenueRead(organizationId), detail = useVenueRead(organizationId, selectedId, true);
  useEffect(() => { onSelected(detail.status === 'ready' ? detail.page : null); }, [detail.status, detail.page, onSelected]);
  return <section className="show-venue-picker" aria-labelledby="choose-venue-title">
    <h3 id="choose-venue-title">Choose the room.</h3><p className="workspace-copy">Changing the venue resets the time and price form. The saved seating plan will be locked when a show uses it.</p>
    <Feedback workspace={list} />
    {list.status === 'ready' && <>
      {!list.page.items.length && <p className="workspace-copy">No venues on this page. <Link to={`/organizers/${organizationId}/venues`}>Create a venue and seating plan</Link> first.</p>}
      <ul className="show-venue-options">{list.page.items.map(venue => <li key={venue.id}><span><strong>{venue.name}</strong><small>{venue.city} / {venue.timezone}</small></span>
        <button type="button" className="secondary-button" aria-pressed={selectedId === venue.id} disabled={busy || selectedId === venue.id || list.page.organization.role !== 'OWNER'} onClick={() => { onSelected(null); setSelectedId(venue.id); }}>Choose<span className="sr-only"> {venue.name}</span></button></li>)}</ul>
      <Pagination workspace={{ ...list, busy }} />
    </>}
    {selectedId && <Feedback workspace={detail} />}
  </section>;
}

export function ShowDirectory() {
  const { organizationId, eventId } = useParams(), workspace = useShows(organizationId, eventId), navigate = useNavigate();
  const ready = workspace.status === 'ready', context = workspace.page;
  const editable = ready && context.organization.role === 'OWNER' && context.event.status === 'DRAFT';
  return <main id="main" className="workspace-page show-page" aria-busy={workspace.status === 'loading' || workspace.busy}>
    <Link className="workspace-back" to={`/organizers/${organizationId}`}>Back to events</Link>
    <WorkspaceHeading workspace={workspace} eyebrow="SEATLEDGER / SHOW SCHEDULE" title={context?.event.title || 'The running order.'}>Each show is one date, one room and one saved ticket price.</WorkspaceHeading>
    <OrganizationNav organizationId={organizationId} /><Feedback workspace={workspace} />
    {ready && <div className="workspace-grid"><section className="workspace-register">
      <div className="workspace-section-title"><span className="eyebrow">01 / SAVED SHOWS</span><span>{context.event.status} / {context.organization.role}</span></div>
      <h2>The dates in the diary.</h2><p className="workspace-copy">Open a show for its venue-local time and details. These schedules do not reserve seats.</p>
      {!context.items.length ? <div className="workspace-empty"><p>No shows on this page.</p><p>{editable ? 'Choose a venue and add the first date.' : 'An owner manages draft schedules.'}</p></div>
        : <ul className="show-list">{context.items.map(show => <li key={show.id}><div><span className="event-category">{show.status}</span><h3><time dateTime={show.startsAt}>{venueTime(show.startsAt, 'UTC')}</time></h3><p className="field-hint">UTC · venue-local time inside</p><p>{money(show.priceMinor, show.currency || 'INR')} <span className="field-hint">per seat</span></p></div>
          <Link className="workspace-event-link" to={`/organizers/${organizationId}/events/${eventId}/shows/${show.id}`}>Open show<span className="sr-only"> {show.id}</span></Link></li>)}</ul>}
      <Pagination workspace={workspace} />
      <Link className="workspace-account-link" to={`/organizers/${organizationId}/events/${eventId}/publication`}>Publication review and saved record</Link>
      <p className="workspace-aside-note">Up to 20 shows per event. Publication creates inventory later. Refreshing or changing pages clears unsaved work.</p>
    </section><aside className="workspace-side">
      {editable ? <CreateShow organizationId={organizationId} workspace={workspace} onSaved={show => navigate(`/organizers/${organizationId}/events/${eventId}/shows/${show.id}`)} />
        : <><p className="eyebrow">SCHEDULE / READ ONLY</p><h2>A settled<br />running order.</h2><p className="workspace-copy">{context.organization.role === 'STAFF' ? 'Staff can read the schedule. An active owner changes draft shows.' : 'This event is no longer a draft. Scheduling changes are closed here.'}</p></>}
    </aside></div>}
  </main>;
}
function CreateShow({ organizationId, workspace, onSaved }) {
  const [venue, setVenue] = useState(null);
  const populated = venue?.sections.length && venue.sections.every(section => section.seats.length);
  return <><p className="eyebrow">02 / ADD AN OCCURRENCE</p><h2>Set a date.</h2><VenuePicker organizationId={organizationId} onSelected={setVenue} busy={workspace.busy} />
    {venue && (populated && venue.organization.role === 'OWNER' ? <TimePriceForm key={venue.id} venue={venue} workspace={workspace} onSaved={onSaved} />
      : <p className="workspace-copy" role="status">{venue.organization.role !== 'OWNER' ? 'Owner access changed. Refresh this workspace.' : 'This venue needs a populated seating plan. Configure it before adding a show.'}</p>)}
  </>;
}

function TimePriceForm({ venue, show, workspace, onSaved, onCancel }) {
  const [localTime, setLocalTime] = useState(show ? wallMinute(show.startsAt, venue.timezone) : '');
  const [occurrence, setOccurrence] = useState(show ? minuteInstant(show.startsAt) : '');
  const [price, setPrice] = useState(show ? priceInput(show.priceMinor) : '');
  const [errors, setErrors] = useState({}), [unchanged, setUnchanged] = useState(false);
  const form = useRef(null), timeInput = useRef(null);
  const resolution = useMemo(() => resolveWallTime(localTime, venue.timezone), [localTime, venue.timezone]);
  useEffect(() => { if (show) timeInput.current?.focus(); }, [show]);
  async function submit(e) {
    e.preventDefault(); if (workspace.busy) return;
    const result = showPayload({ localTime, occurrence, price }, venue, show, resolution); setErrors(result.errors);
    if (Object.keys(result.errors).length) { const name = ['localTime', 'occurrence', 'price'].find(key => result.errors[key]); form.current.querySelector(`[name="${name}"]`)?.focus(); return; }
    if (result.unchanged) { setUnchanged(true); return; }
    try {
      const saved = await workspace.mutate(show ? 'patch' : 'create', result.body, show ? 'Show changes saved.' : 'Show saved.', { refreshAfter: Boolean(show) }); onSaved(saved);
    } catch { /* Shared recovery clears unsafe controls; never replay a save. */ }
  }
  const preservingTime = show && localTime === wallMinute(show.startsAt, venue.timezone) && occurrence === minuteInstant(show.startsAt);
  const chosen = preservingTime ? show.startsAt : resolution.candidates?.length === 1 ? resolution.candidates[0] : occurrence;
  return <form ref={form} className="show-time-form" onSubmit={submit} noValidate>
    <div className="show-selected-venue"><p className="eyebrow">{venue.city} / SELECTED VENUE</p><h3>{venue.name}</h3><p>Venue timezone: <strong>{venue.timezone}</strong></p></div>
    <fieldset disabled={workspace.busy}>
      <div className="field"><label htmlFor="show-local-time">Venue date and time</label><input ref={timeInput} id="show-local-time" name="localTime" type="datetime-local" step="60" min="2000-01-01T00:00" max="2100-12-31T23:59" required value={localTime} onChange={e => { setLocalTime(e.target.value); setOccurrence(''); setErrors({}); setUnchanged(false); }} aria-invalid={Boolean(errors.localTime)} aria-describedby={`show-time-hint${errors.localTime ? ' show-time-error' : ''}`} />
        <p className="field-hint" id="show-time-hint">Use the venue's clock, not your device's timezone. Starts must be in the future.</p>{errors.localTime && <p className="field-error" id="show-time-error">{errors.localTime}</p>}</div>
      {resolution.candidates?.length > 1 && <div className="show-time-choice" role="group" aria-labelledby="occurrence-label"><p id="occurrence-label">This clock time repeats. Which occurrence?</p>
        {resolution.candidates.map((instant, i) => <label key={instant}><input name="occurrence" type="radio" value={instant} checked={occurrence === instant} onChange={() => { setOccurrence(instant); setErrors({}); setUnchanged(false); }} />{i === 0 ? 'Earlier' : 'Later'} occurrence — {instant}</label>)}
        {errors.occurrence && <p className="field-error" role="alert">{errors.occurrence}</p>}</div>}
      {localTime && chosen && (preservingTime || resolution.candidates?.includes(chosen)) && <p className="show-instant">{preservingTime ? 'Saved instant' : 'Scheduled instant'} <time dateTime={chosen}>{chosen}</time></p>}
      <div className="field"><label htmlFor="show-price">Ticket price (INR)</label><input id="show-price" name="price" type="text" inputMode="decimal" maxLength={12} required value={price} onChange={e => { setPrice(e.target.value); setErrors(v => ({ ...v, price: '' })); setUnchanged(false); }} aria-invalid={Boolean(errors.price)} aria-describedby={`show-price-hint${errors.price ? ' show-price-error' : ''}`} />
        <p className="field-hint" id="show-price-hint">One price for every seat. Use 0 for a free show. All payments are simulated.</p>{errors.price && <p className="field-error" id="show-price-error">{errors.price}</p>}</div>
      {unchanged && <p className="field-hint" role="status">There are no changes to save.</p>}
      <button type="submit" className="primary-button">{workspace.busy ? 'Saving show…' : show ? 'Save show changes' : 'Save new show'}</button>
      {onCancel && <button type="button" className="text-button" onClick={onCancel}>Cancel editing</button>}
    </fieldset>
    <p className="workspace-aside-note">{show ? 'Only changed time or price is saved. The venue stays fixed.' : 'Saving adds a draft occurrence and locks this venue plan. It does not publish the event or create customer inventory.'}</p>
  </form>;
}

export function ShowDetail() {
  const { organizationId, eventId, showId } = useParams(), workspace = useShows(organizationId, eventId, showId), navigate = useNavigate();
  const [mode, setMode] = useState(null), triggers = useRef({}), focusAfter = useRef(null), confirmation = useRef(null);
  const ready = workspace.status === 'ready', show = workspace.page;
  const canEdit = ready && show.organization.role === 'OWNER' && show.event.status === 'DRAFT' && show.status === 'SCHEDULED' && !show.inUse && [null, 'INR'].includes(show.currency);
  useEffect(() => { if (!ready) setMode(null); }, [ready]);
  useEffect(() => { if (mode === 'remove') confirmation.current?.focus(); else if (!mode && focusAfter.current) { triggers.current[focusAfter.current]?.focus(); focusAfter.current = null; } }, [mode]);
  const cancel = key => { focusAfter.current = key; setMode(null); };
  async function remove() {
    try { await workspace.mutate('delete', { expectedRevision: show.revision }, 'Show removed.', { refreshAfter: false }); navigate(`/organizers/${organizationId}/events/${eventId}/shows`); } catch { /* No automatic delete replay. */ }
  }
  return <main id="main" className="workspace-page show-page" aria-busy={workspace.status === 'loading' || workspace.busy}>
    <Link className="workspace-back" to={`/organizers/${organizationId}/events/${eventId}/shows`}>Back to show schedule</Link>
    <WorkspaceHeading workspace={workspace} eyebrow="SEATLEDGER / SAVED SHOW" title={show?.event.title || 'A date in the diary.'}>The saved room, time and price for this occurrence.</WorkspaceHeading>
    <OrganizationNav organizationId={organizationId} /><Feedback workspace={workspace} />
    {ready && <>
      <Link className="workspace-event-link" to={`/organizers/${organizationId}/events/${eventId}/publication`}>Publication review and saved record</Link>
      <Link className="workspace-account-link" to={`/organizers/${organizationId}/events/${eventId}/shows/${showId}/check-in`}>Open entrance register / simulated check-in</Link>
      <Link className="workspace-account-link" to={`/organizers/${organizationId}/events/${eventId}/shows/${showId}/operations`}>Bookings, attendance & simulated totals</Link>
      <section className="show-detail-ledger" aria-label="Saved show details"><div><p className="eyebrow">WHEN / {show.status}</p><h2><time dateTime={show.startsAt}>{venueTime(show.startsAt, show.venue.timezone)}</time></h2><p>{show.venue.timezone}</p><small>UTC: {show.startsAt}</small></div>
        <div><p className="eyebrow">WHERE</p><h2>{show.venue.name}</h2><p>{show.venue.city}</p><Link to={`/organizers/${organizationId}/venues/${show.venueId}`}>View saved seating plan</Link></div>
        <div><p className="eyebrow">PER SEAT</p><h2>{money(show.priceMinor, show.currency || 'INR')}</h2><p>{show.venue.sections.reduce((sum, section) => sum + section.seats.length, 0)} physical seats</p><small>Configuration count, not availability</small></div></section>
      <p className="workspace-copy">{show.inUse ? 'Inventory or agreements exist for this show. Draft edits and removal are closed.' : show.event.status !== 'DRAFT' ? 'This event is no longer a draft. Its schedule is read only here.' : show.organization.role === 'STAFF' ? 'Staff access is read only. An owner manages unused draft shows.' : !canEdit ? 'This show cannot be edited here in its current state or currency.' : 'This unused draft can be edited or removed. Publishing is a separate step.'}</p>
      {canEdit && !mode && <div className="show-actions"><button ref={node => { triggers.current.edit = node; }} className="primary-button" onClick={() => setMode('edit')}>Edit time and price</button><button ref={node => { triggers.current.remove = node; }} className="secondary-button suspend-button" onClick={() => setMode('remove')}>Remove draft show</button></div>}
      {canEdit && mode === 'edit' && <section className="show-edit-panel"><h2>Edit this occurrence.</h2><TimePriceForm show={show} venue={show.venue} workspace={workspace} onSaved={() => setMode(null)} onCancel={() => cancel('edit')} /></section>}
      {canEdit && mode === 'remove' && <section className="layout-confirmation"><h2 ref={confirmation} tabIndex="-1">Remove this draft show?</h2><p>This removes the unused schedule. It does not cancel sold tickets or issue refunds. The server checks again before removal.</p><div className="show-actions"><button className="primary-button suspend-button" disabled={workspace.busy} onClick={remove}>Confirm removal</button><button className="secondary-button" disabled={workspace.busy} onClick={() => cancel('remove')}>Keep show</button></div></section>}
    </>}
  </main>;
}
