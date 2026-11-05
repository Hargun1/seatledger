import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Feedback, Pagination, WorkspaceHeading } from '../organizers/Workspace.jsx';
import { OrganizationNav } from '../organizers/OrganizationNav.jsx';
import { createWorkspaceStore } from '../organizers/workspace-store.js';
import { venueRequest } from './client.js';
import { validateMetadata, validatePlan, planFromSaved, previewSections } from './model.js';

function useVenues(organizationId, venueId) {
  const auth = useAuth(), userId = auth.session.user.id, csrfToken = auth.session.csrfToken;
  const store = useMemo(() => createWorkspaceStore({
    load: options => venueRequest(venueId ? 'detail' : 'list', { ...options, organizationId, venueId }),
    write: (action, body) => venueRequest(action, { organizationId, venueId, body, csrfToken }), onAuthRequired: auth.refresh
  }), [organizationId, venueId, userId, csrfToken, auth.refresh]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { store.refresh(); return store.cancel; }, [store]);
  return { ...state, refresh: store.refresh, mutate: store.mutate, recover: auth.refresh };
}
function Input({ id, label, error, hint, ...props }) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} required aria-invalid={Boolean(error)} aria-describedby={[error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined} {...props} />
    {error && <p className="field-error" id={`${id}-error`}>{error}</p>}{hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}</div>;
}

export function VenueDirectory() {
  const { organizationId } = useParams(), workspace = useVenues(organizationId), navigate = useNavigate();
  const ready = workspace.status === 'ready', owner = workspace.page?.organization.role === 'OWNER';
  async function create(data) {
    const venue = await workspace.mutate('create', data, 'Venue created.', { refreshAfter: false });
    navigate(`/organizers/${organizationId}/venues/${venue.id}`);
  }
  return <main id="main" className="workspace-page" aria-busy={workspace.busy || workspace.status === 'loading'}>
    <Link className="workspace-back" to="/organizers">← Your organizations</Link>
    <WorkspaceHeading workspace={workspace} eyebrow="SEATLEDGER / VENUES" title={<>A place for <em>live.</em></>}>{workspace.page?.organization.name || 'The rooms and rows behind your programme.'}</WorkspaceHeading>
    <OrganizationNav organizationId={organizationId} /><Feedback workspace={workspace} />
    {ready && <div className="workspace-grid"><section className="workspace-register" aria-labelledby="venues-title"><div className="workspace-section-title"><span className="eyebrow">01 / YOUR PLACES</span><span>{owner ? 'OWNER ACCESS' : 'STAFF / READ ONLY'}</span></div>
      <h2 id="venues-title">Rooms with a little character.</h2>
      {!workspace.page.items.length ? <div className="workspace-empty"><p>No venues on this page.</p><p>{owner ? 'Add a venue, then define its sections and seat rows.' : 'An owner can add venues for your organization.'}</p></div>
        : <ul className="venue-list">{workspace.page.items.map(venue => <li key={venue.id}><span className="event-category">{venue.city}</span><h3>{venue.name}</h3><p>{venue.timezone}</p><Link className="workspace-event-link" to={`/organizers/${organizationId}/venues/${venue.id}`}>Open venue <span className="sr-only">{venue.name}</span><span aria-hidden="true">↗</span></Link></li>)}</ul>}
      <Pagination workspace={workspace} />
    </section><aside className="workspace-side"><p className="eyebrow">02 / {owner ? 'ADD A VENUE' : 'A SHARED CATALOGUE'}</p><h2>{owner ? 'Set the address.' : 'Know the room.'}</h2>
      {owner ? <><p className="workspace-copy">Start with the place. You will define its seating plan next.</p><MetadataForm workspace={workspace} save={create} /></>
        : <p className="workspace-copy">Open a venue to see its details and saved seating plan. Owners manage changes.</p>}
    </aside></div>}
  </main>;
}

export function VenueDetail() {
  const { organizationId, venueId } = useParams(), workspace = useVenues(organizationId, venueId), navigate = useNavigate();
  const [mode, setMode] = useState('view'), trigger = useRef(null), actionButtons = useRef({}), restoreFocus = useRef(false);
  const ready = workspace.status === 'ready', venue = workspace.page;
  const editable = ready && venue.organization.role === 'OWNER' && !venue.hasShows;
  useEffect(() => { if (!ready) setMode('view'); }, [ready]);
  useEffect(() => {
    if (mode !== 'view') document.getElementById('venue-editor-title')?.focus();
    else if (restoreFocus.current) { actionButtons.current[trigger.current]?.focus(); restoreFocus.current = false; }
  }, [mode]);
  function edit(next) { trigger.current = next; setMode(next); }
  function cancel() { restoreFocus.current = true; setMode('view'); }
  async function remove() {
    try {
      await workspace.mutate('delete', { expectedRevision: venue.revision }, 'Venue removed.', { refreshAfter: false });
      navigate(`/organizers/${organizationId}/venues`, { replace: true });
    } catch { /* Recovery view owns the failure. */ }
  }
  return <main id="main" className="workspace-page venue-detail" aria-busy={workspace.busy || workspace.status === 'loading'}>
    <Link className="workspace-back" to={`/organizers/${organizationId}/venues`}>← All venues</Link>
    <WorkspaceHeading workspace={workspace} eyebrow="SEATLEDGER / VENUE WORKROOM" title={venue?.name || 'The venue workroom.'}>{venue ? `${venue.city} / ${venue.timezone}` : 'The place and its seating plan.'}</WorkspaceHeading>
    <OrganizationNav organizationId={organizationId} /><Feedback workspace={workspace} />
    {ready && <>
      <div className="venue-summary"><dl><div><dt>CITY</dt><dd>{venue.city}</dd></div><div><dt>TIMEZONE</dt><dd>{venue.timezone}</dd></div><div><dt>SAVED SEATS</dt><dd>{venue.sections.reduce((n, section) => n + section.seats.length, 0)}</dd></div></dl>
        <span className={`status-label ${venue.hasShows ? 'status-suspended' : 'status-draft'}`}>{venue.hasShows ? 'Used by a show · Locked' : venue.organization.role === 'STAFF' ? 'Staff · Read only' : 'Unused venue'}</span></div>
      {venue.hasShows && <p className="notice">A show uses this venue. Its details and seating plan are locked, including when the show is cancelled.</p>}
      {mode === 'view' || !editable ? <>
        {editable && <div className="venue-actions"><button ref={node => { actionButtons.current.details = node; }} className="secondary-button" onClick={() => edit('details')}>Edit venue details</button><button ref={node => { actionButtons.current.layout = node; }} className="secondary-button" onClick={() => edit('layout')}>{venue.sections.length ? 'Edit seating plan' : 'Define seating plan'}</button><button ref={node => { actionButtons.current.delete = node; }} className="quiet-button suspend-button" onClick={() => edit('delete')}>Remove unused venue</button></div>}
        <SeatPlan sections={venue.sections} title="Saved seating plan" />
      </> : mode === 'details' ? <div className="workspace-grid"><section className="workspace-register"><p className="eyebrow">EDIT THE PLACE</p><h2 tabIndex="-1" id="venue-editor-title">A few details.</h2><p className="workspace-copy">Your saved seating plan stays as it is.</p></section><aside className="workspace-side"><MetadataForm venue={venue} workspace={workspace} cancel={cancel} save={data => {
        const changed = Object.fromEntries(Object.entries(data).filter(([key, value]) => value !== venue[key]));
        return workspace.mutate('patch', { expectedRevision: venue.revision, ...changed }, 'Venue details saved.');
      }} /></aside></div>
      : mode === 'layout' ? <LayoutEditor key={`${venue.id}-${venue.revision}`} venue={venue} workspace={workspace} cancel={cancel} />
      : <section className="venue-remove" aria-labelledby="venue-editor-title"><p className="eyebrow">REMOVE AN UNUSED PLACE</p><h2 tabIndex="-1" id="venue-editor-title">Remove this venue?</h2><p>{venue.name} and its saved seating plan will be removed. This is available only while no show uses the venue.</p><div className="venue-actions"><button className="secondary-button suspend-button" disabled={workspace.busy} onClick={remove}>{workspace.busy ? 'Removing…' : 'Confirm removal'}</button><button className="quiet-button" disabled={workspace.busy} onClick={cancel}>Keep venue</button></div></section>}
    </>}
  </main>;
}

function MetadataForm({ venue, workspace, save, cancel }) {
  const [fields, setFields] = useState({ name: venue?.name || '', city: venue?.city || '', timezone: venue?.timezone || 'Asia/Kolkata' });
  const [errors, setErrors] = useState({}), [unchanged, setUnchanged] = useState(false), form = useRef(null);
  async function submit(e) {
    e.preventDefault(); if (workspace.busy) return;
    const parsed = validateMetadata(fields); setErrors(parsed.errors);
    const first = ['name', 'city', 'timezone'].find(key => parsed.errors[key]);
    if (first) { form.current.elements.namedItem(first)?.focus(); return; }
    if (venue && Object.entries(parsed.data).every(([key, value]) => value === venue[key])) { setUnchanged(true); return; }
    try { await save(parsed.data); } catch { /* Store shows sanitized recovery. */ }
  }
  const change = e => { setFields(value => ({ ...value, [e.target.name]: e.target.value })); setErrors(value => ({ ...value, [e.target.name]: '' })); setUnchanged(false); };
  return <form ref={form} onSubmit={submit} noValidate><fieldset disabled={workspace.busy}>
    <Input id="venue-name" name="name" label="Venue name" value={fields.name} maxLength={160} error={errors.name} onChange={change} />
    <Input id="venue-city" name="city" label="City" value={fields.city} maxLength={120} error={errors.city} onChange={change} />
    <Input id="venue-timezone" name="timezone" label="Named timezone" value={fields.timezone} maxLength={64} list="venue-zones" error={errors.timezone} hint="For example, Asia/Kolkata or UTC. This is a named timezone, not a numeric offset." onChange={change} />
    <datalist id="venue-zones">{['Asia/Kolkata', 'UTC', 'Europe/London', 'America/New_York'].map(zone => <option value={zone} key={zone} />)}</datalist>
    {unchanged && <p role="status" className="field-hint">There are no changes to save.</p>}
    <button className="primary-button" type="submit">{workspace.busy ? 'Saving…' : venue ? 'Save venue details' : 'Create venue'}<span aria-hidden="true">→</span></button>
    {cancel && <button className="text-button" type="button" onClick={cancel}>Keep saved details</button>}
  </fieldset><p className="workspace-aside-note">Refresh or navigation clears unsaved changes. Once a show uses this venue, details and seating become read-only.</p></form>;
}

function keyed(plan) { return plan.map(section => ({ ...section, key: crypto.randomUUID(), rows: section.rows.map(row => ({ ...row, key: crypto.randomUUID() })) })); }
function LayoutEditor({ venue, workspace, cancel }) {
  const [sections, setSections] = useState(() => { const plan = planFromSaved(venue.sections); return plan && keyed(plan); });
  const [errors, setErrors] = useState({}), [pending, setPending] = useState(null);
  const form = useRef(null), planError = useRef(null), confirmation = useRef(null), reviewButton = useRef(null), restoring = useRef(false);
  const proposed = sections ? validatePlan(sections, venue.revision) : null;
  useEffect(() => { if (pending) confirmation.current?.focus(); else if (restoring.current) { reviewButton.current?.focus(); restoring.current = false; } }, [pending]);
  useEffect(() => { if (errors.plan && Object.keys(errors).length === 1) planError.current?.focus(); }, [errors]);
  function change(work) { setSections(work); setErrors({}); }
  function review(e) {
    e.preventDefault(); if (workspace.busy || pending) return;
    const checked = validatePlan(sections, venue.revision); setErrors(checked.errors);
    if (!checked.valid) { [...form.current.querySelectorAll('input')].find(input => checked.errors[input.dataset.errorKey])?.focus(); return; }
    setPending(checked);
  }
  async function commit() {
    if (workspace.busy || !pending) return;
    try { await workspace.mutate('layout', { expectedRevision: venue.revision, sections: pending.data }, 'Seating plan saved.'); }
    catch { /* No automatic PUT retry after uncertainty or stale revision. */ }
  }
  return <section className="layout-editor" aria-labelledby="venue-editor-title"><div className="venue-section-heading"><div><p className="eyebrow">PLAN THE ROOM</p><h2 id="venue-editor-title" tabIndex="-1">Every row, considered.</h2></div><button className="secondary-button" disabled={workspace.busy} onClick={cancel}>Keep saved plan</button></div>
    <p className="workspace-copy">Changes below are a proposal. The saved plan changes only after you review and confirm. Up to 20 sections, 26 rows per section, 40 seats per row and 500 seats in total.</p>
    {!sections ? <div className="workspace-empty"><p>This saved plan cannot be edited as consecutive row counts.</p><p>Its existing seat numbers remain visible below. To change it, explicitly start a new plan and review the replacement.</p><button className="secondary-button" onClick={() => setSections(keyed(planFromSaved([])))}>Start a new plan</button><SeatPlan sections={venue.sections} title="Saved seating plan" /></div> : <>
      {errors.plan && <p ref={planError} tabIndex="-1" className="form-error" role="alert">{errors.plan}</p>}
      <form ref={form} onSubmit={review} noValidate><fieldset disabled={workspace.busy || Boolean(pending)}>
        {sections.map((section, i) => <section className="layout-section" key={section.key} aria-label={`Section ${i + 1}`}><div className="layout-section-header"><span className="eyebrow">SECTION {String(i + 1).padStart(2, '0')}</span><button className="quiet-button" type="button" disabled={sections.length === 1} aria-label={`Remove section ${i + 1}`} onClick={() => change(value => value.filter((_, index) => index !== i))}>Remove section</button></div>
          <Input id={`plan-${section.key}`} data-error-key={`section-${i}`} label="Section name" value={section.name} maxLength={80} error={errors[`section-${i}`]} onChange={e => change(value => value.map((item, index) => index === i ? { ...item, name: e.target.value } : item))} />
          {section.rows.map((row, j) => <div className="layout-row" key={row.key}>
            <Input id={`label-${row.key}`} data-error-key={`label-${i}-${j}`} label="Row label" value={row.label} maxLength={8} error={errors[`label-${i}-${j}`]} onChange={e => change(value => value.map((item, index) => index === i ? { ...item, rows: item.rows.map((r, n) => n === j ? { ...r, label: e.target.value } : r) } : item))} />
            <Input id={`count-${row.key}`} data-error-key={`seats-${i}-${j}`} label="Seats in row" type="number" min="1" max="40" step="1" inputMode="numeric" value={row.seats} error={errors[`seats-${i}-${j}`]} onChange={e => change(value => value.map((item, index) => index === i ? { ...item, rows: item.rows.map((r, n) => n === j ? { ...r, seats: e.target.value } : r) } : item))} />
            <button className="quiet-button" type="button" disabled={section.rows.length === 1} aria-label={`Remove row ${j + 1} from section ${i + 1}`} onClick={() => change(value => value.map((item, index) => index === i ? { ...item, rows: item.rows.filter((_, n) => n !== j) } : item))}>Remove row</button>
          </div>)}
          <button className="secondary-button" type="button" disabled={section.rows.length >= 26} onClick={() => change(value => value.map((item, index) => index === i ? { ...item, rows: [...item.rows, { key: crypto.randomUUID(), label: '', seats: '8' }] } : item))}>Add row</button>
        </section>)}
        <div className="venue-actions"><button className="secondary-button" type="button" disabled={sections.length >= 20} onClick={() => change(value => [...value, ...keyed([{ name: '', rows: [{ label: 'A', seats: '8' }] }])])}>Add section</button><button className="primary-button" ref={reviewButton} type="submit">Review seating plan <span aria-hidden="true">→</span></button></div>
      </fieldset></form>
      {pending && <section className="layout-confirmation" aria-labelledby="plan-confirm-title"><p className="eyebrow">CONFIRM REPLACEMENT</p><h3 ref={confirmation} id="plan-confirm-title" tabIndex="-1">Replace the saved plan?</h3><p>The current plan will be replaced with {pending.data.length} sections and {pending.total} seats. This is allowed only while no show uses the venue.</p><p>If someone changed the venue since you opened it, the server will ask you to reload.</p><div className="venue-actions"><button className="secondary-button" disabled={workspace.busy} onClick={commit}>{workspace.busy ? 'Saving…' : 'Confirm seating plan'}</button><button className="quiet-button" disabled={workspace.busy} onClick={() => { restoring.current = true; setPending(null); }}>Continue editing</button></div></section>}
      {proposed.valid ? <SeatPlan sections={previewSections(proposed.data)} title="Proposed seating plan" proposed /> : <p className="field-hint">Complete the rows and resolve any limits to preview your proposal.</p>}
      <p className="workspace-aside-note">Reviewing does not save. Confirmation replaces the entire plan, including the saved seat references. Refresh or navigation clears your proposal.</p>
    </>}
  </section>;
}

function SeatPlan({ sections, title, proposed = false }) {
  return <section className="seat-plan" aria-label={title}><div className="venue-section-heading"><h2>{title}</h2><span className="status-label status-draft">{proposed ? 'Not saved' : 'Saved'}</span></div>
    <p className="workspace-copy">Venue layout only. These seats do not show availability for a performance.</p>
    {!sections.length ? <div className="workspace-empty"><p>No seating plan saved yet.</p></div> : sections.map(section => {
      const rows = new Map(); for (const seat of section.seats) { if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []); rows.get(seat.rowLabel).push(seat); }
      return <section className="seat-section" key={section.id}><h3>{section.name}</h3>{[...rows].map(([label, seats]) => <div className="seat-row" key={label}><span className="seat-row-label">Row {label}</span><ol aria-label={`${section.name}, row ${label}`}>{seats.map(seat => <li key={seat.id} aria-label={`Seat ${seat.number}`}>{seat.number}</li>)}</ol></div>)}</section>;
    })}
  </section>;
}
