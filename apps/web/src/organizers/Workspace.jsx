import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { workspaceRequest } from './client.js';
import { createWorkspaceStore } from './workspace-store.js';
import { OrganizationNav } from './OrganizationNav.jsx';

function useWorkspace(organizationId) {
  const auth = useAuth();
  const { id: userId } = auth.session.user, csrfToken = auth.session.csrfToken;
  const store = useMemo(() => createWorkspaceStore({
    load: options => workspaceRequest(organizationId ? 'events' : 'mine', { ...options, organizationId }),
    write: (action, { eventId, ...body }) => workspaceRequest(action, { organizationId, eventId, body, csrfToken }),
    onAuthRequired: auth.refresh
  }), [organizationId, userId, csrfToken, auth.refresh]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { store.refresh(); return store.cancel; }, [store]);
  return { ...state, refresh: store.refresh, mutate: store.mutate, recover: auth.refresh };
}

const statusLabels = { PENDING: 'Awaiting review', APPROVED: 'Approved', SUSPENDED: 'Suspended', DRAFT: 'Draft', PUBLISHED: 'Published', CANCELLED: 'Cancelled' };
function Status({ value }) { return <span className={`status-label status-${value.toLowerCase()}`}>{statusLabels[value]}</span>; }
export function Feedback({ workspace }) {
  const ref = useRef(null);
  useEffect(() => { if (workspace.error || workspace.notice) ref.current?.focus(); }, [workspace.error, workspace.notice, workspace.status]);
  return <>
    {workspace.notice && <p className="notice" role="status" tabIndex="-1" ref={!workspace.error ? ref : undefined}>{workspace.notice}</p>}
    {workspace.error && <div className="workspace-error" ref={ref} tabIndex="-1"><p role="alert">{workspace.error}</p>
      <p>Reloading checks your session and the latest saved data. Unsaved form changes will be cleared.</p>
      <button className="secondary-button" onClick={() => workspace.recover()}>Reload workspace</button></div>}
    {workspace.status === 'loading' && <p className="workspace-loading" role="status">Loading your workspace.</p>}
  </>;
}
export function Pagination({ workspace }) {
  return <div className="workspace-pagination" aria-label="List pages">
    <span>Up to 20 per page · Ordered by reference</span>
    <div>{workspace.cursor && <button className="secondary-button" disabled={workspace.busy} onClick={() => workspace.refresh()}>First page</button>}
      {workspace.page.nextCursor && <button className="secondary-button" disabled={workspace.busy} onClick={() => workspace.refresh({ cursor: workspace.page.nextCursor })}>Next page <span aria-hidden="true">→</span></button>}</div>
  </div>;
}
export function WorkspaceHeading({ eyebrow, title, children, workspace }) {
  return <header className="workspace-heading"><div><p className="eyebrow">{eyebrow}</p><h1 tabIndex="-1">{title}</h1><p>{children}</p></div>
    <button className="secondary-button" disabled={workspace.busy || workspace.status === 'loading'} onClick={() => workspace.recover()}>Refresh workspace <span aria-hidden="true">↻</span></button></header>;
}

export function Organizations() {
  const workspace = useWorkspace();
  const ready = workspace.status === 'ready';
  const pending = ready && workspace.page.items.some(row => row.role === 'OWNER' && row.status === 'PENDING');
  return <main id="main" className="workspace-page" aria-busy={workspace.status === 'loading' || workspace.busy}>
    <Link className="workspace-back" to="/account">← Your account</Link>
    <WorkspaceHeading workspace={workspace} eyebrow="SEATLEDGER / ORGANIZERS" title={<>Behind the <em>programme.</em></>}>A home for the people who bring an evening together.</WorkspaceHeading>
    <Feedback workspace={workspace} />
    {ready && <div className="workspace-grid"><section className="workspace-register" aria-labelledby="organizations-title">
      <div className="workspace-section-title"><span className="eyebrow">01 / YOUR ORGANIZATIONS</span><span>ACCESS & STATUS</span></div>
      <h2 id="organizations-title">Your programme starts here.</h2>
      {!workspace.page.items.length ? <div className="workspace-empty"><p>{workspace.cursor ? 'No organizations on this page.' : 'No organizations to show yet.'}</p><p>Request access for your organization. An administrator reviews each application before event work opens.</p></div>
        : <ul className="organization-list">{workspace.page.items.map(row => <li key={row.id}><div className="organization-topline"><span className="membership-label">{row.role === 'OWNER' ? 'Owner' : 'Staff'}</span><Status value={row.status} /></div>
          <h3>{row.name}</h3><p>{row.status === 'PENDING' ? 'Your request is waiting for administrator review.' : row.status === 'SUSPENDED' ? 'Event access is paused. Contact your administrator.' : row.role === 'STAFF' ? 'Read-only event access for your team.' : 'Your event workspace is open.'}</p>
          {row.status === 'APPROVED' && <Link className="workspace-event-link" to={`/organizers/${row.id}`}>Open events <span aria-hidden="true">↗</span></Link>}</li>)}</ul>}
      <Pagination workspace={workspace} />
    </section><aside className="workspace-side"><div className="workspace-section-title"><span className="eyebrow">02 / A NEW ORGANIZATION</span></div>
      <h2>Bring people<br />together.</h2><p className="workspace-copy">Tell us the name behind your events. Approval opens your event workspace; submitting a request does not publish anything.</p>
      {pending ? <div className="workspace-empty"><p>You have a request awaiting review.</p><p>Refresh this workspace to check for a decision before making another request.</p></div> : <OrganizationForm workspace={workspace} />}
      <p className="workspace-aside-note">One pending owner request at a time. Only active memberships appear here. Other organizations may be on later pages.</p>
    </aside></div>}
  </main>;
}

function OrganizationForm({ workspace }) {
  const [name, setName] = useState(''), [error, setError] = useState('');
  const field = useRef(null);
  async function submit(e) {
    e.preventDefault(); if (workspace.busy) return;
    const value = name.trim();
    if (!value || value.length > 160) { setError('Enter an organization name between 1 and 160 characters.'); field.current?.focus(); return; }
    setError('');
    try { await workspace.mutate('request', { name: value }, 'Request received. Your organization is awaiting administrator review.'); setName(''); }
    catch { /* The store exposes safe failure/recovery state. Never replay POST. */ }
  }
  return <form onSubmit={submit} noValidate><fieldset disabled={workspace.busy}>
    <div className="field"><label htmlFor="organization-name">Organization name</label><input ref={field} id="organization-name" value={name} maxLength={160} required aria-invalid={Boolean(error)} aria-describedby={error ? 'organization-name-error' : undefined} onChange={e => { setName(e.target.value); setError(''); }} />
      {error && <p className="field-error" id="organization-name-error">{error}</p>}</div>
    <button className="primary-button" type="submit">{workspace.busy ? 'Sending request…' : 'Request organization access'}<span aria-hidden="true">→</span></button>
  </fieldset></form>;
}

export function EventsWorkspace() {
  const { organizationId } = useParams();
  const workspace = useWorkspace(organizationId);
  const [editing, setEditing] = useState(null);
  const editTrigger = useRef(null);
  useEffect(() => { if (workspace.status !== 'ready') setEditing(null); }, [workspace.status]);
  const ready = workspace.status === 'ready', organization = workspace.page?.organization;
  const owner = organization?.role === 'OWNER';
  return <main id="main" className="workspace-page" aria-busy={workspace.status === 'loading' || workspace.busy}>
    <Link className="workspace-back" to="/organizers">← Your organizations</Link>
    <WorkspaceHeading workspace={workspace} eyebrow="SEATLEDGER / EVENT WORKSPACE" title={<>The next <em>evening.</em></>}>{organization ? organization.name : 'Your organization’s events and working drafts.'}</WorkspaceHeading>
    <OrganizationNav organizationId={organizationId} /><Feedback workspace={workspace} />
    {ready && <div className={`workspace-grid ${owner ? '' : 'workspace-readonly'}`}><section className="workspace-register" aria-labelledby="events-title">
      <div className="workspace-section-title"><span className="eyebrow">01 / THE PROGRAMME</span><span>{owner ? 'OWNER ACCESS' : 'STAFF / READ ONLY'}</span></div>
      <h2 id="events-title">Events in the making.</h2>
      <p className="workspace-copy">Drafts stay private. Configure a venue, then open an event's show schedule to add its dates.</p>
      {!workspace.page.items.length ? <div className="workspace-empty"><p>No events on this page.</p><p>{owner ? 'Start with a title and category. You can refine your draft before publishing tools open.' : 'An owner can add event drafts for your team.'}</p></div>
        : <ul className="event-list">{workspace.page.items.map(row => <li key={row.id}><div><span className="event-category">{row.category}</span><h3>{row.title}</h3><Status value={row.status} /></div>
          <div className="event-row-actions"><Link className="workspace-event-link" to={`/organizers/${organizationId}/events/${row.id}/shows`}>Show schedule<span className="sr-only">: {row.title}</span></Link>
          {row.status!=='DRAFT'&&<Link className="workspace-event-link" to={`/organizers/${organizationId}/events/${row.id}/cancellation`}>Cancellation & recovery<span className="sr-only">: {row.title}</span></Link>}
          {owner && row.status === 'DRAFT' ? <button className="secondary-button" disabled={workspace.busy} onClick={e => { editTrigger.current = e.currentTarget; setEditing(row); }}>Edit draft<span className="sr-only">: {row.title}</span></button> : <span className="field-hint">Read only</span>}</div></li>)}</ul>}
      <Pagination workspace={workspace} />
    </section>{owner ? <aside className="workspace-side"><DraftForm key={editing?.id || 'new'} event={editing} workspace={workspace} cancel={() => { setEditing(null); editTrigger.current?.focus(); }} /></aside>
      : <aside className="workspace-side"><p className="eyebrow">YOUR ROLE / STAFF</p><h2>A shared<br />programme.</h2><p className="workspace-copy">You can read the organization’s events. An owner manages draft changes.</p></aside>}</div>}
  </main>;
}

function DraftForm({ event, workspace, cancel }) {
  const [fields, setFields] = useState({ title: event?.title || '', category: event?.category || '' });
  const [errors, setErrors] = useState({}), [unchanged, setUnchanged] = useState(false);
  const titleRef = useRef(null), categoryRef = useRef(null);
  useEffect(() => { if (event) titleRef.current?.focus(); }, [event]);
  const change = e => { setFields(value => ({ ...value, [e.target.name]: e.target.value })); setErrors(value => ({ ...value, [e.target.name]: '' })); setUnchanged(false); };
  async function submit(e) {
    e.preventDefault(); if (workspace.busy) return;
    const title = fields.title.trim(), category = fields.category.trim();
    const next = { ...(!title || title.length > 200 ? { title: 'Enter a title between 1 and 200 characters.' } : {}),
      ...(!category || category.length > 60 ? { category: 'Enter a category between 1 and 60 characters.' } : {}) };
    setErrors(next);
    if (Object.keys(next).length) { (next.title ? titleRef : categoryRef).current?.focus(); return; }
    const body = event ? { eventId: event.id, ...(title !== event.title ? { title } : {}), ...(category !== event.category ? { category } : {}) } : { title, category };
    if (event && Object.keys(body).length === 1) { setUnchanged(true); return; }
    try { await workspace.mutate(event ? 'update' : 'create', body, event ? 'Draft changes saved.' : 'Draft saved. It is private and has not been published.'); setFields({ title: '', category: '' }); }
    catch { /* Safe recovery is shown by Feedback; no automatic mutation retry. */ }
  }
  return <><div className="workspace-section-title"><span className="eyebrow">02 / {event ? 'REFINE A DRAFT' : 'START SOMETHING'}</span></div><h2>{event ? 'A little refining.' : 'Set the scene.'}</h2>
    <p className="workspace-copy">{event ? 'Change the details below. Only the fields you change will be saved.' : 'Every good evening starts with an idea. Give yours a name.'}</p>
    <form onSubmit={submit} noValidate><fieldset disabled={workspace.busy}>
      <div className="field"><label htmlFor="event-title">Event title</label><input ref={titleRef} id="event-title" name="title" value={fields.title} maxLength={200} required onChange={change} aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? 'event-title-error' : undefined} />{errors.title && <p className="field-error" id="event-title-error">{errors.title}</p>}</div>
      <div className="field"><label htmlFor="event-category">Category</label><input ref={categoryRef} id="event-category" name="category" value={fields.category} maxLength={60} required onChange={change} aria-invalid={Boolean(errors.category)} aria-describedby={errors.category ? 'event-category-error' : 'event-category-hint'} />
        <p className="field-hint" id="event-category-hint">For example, Music, Theatre or Talks.</p>{errors.category && <p className="field-error" id="event-category-error">{errors.category}</p>}</div>
      {unchanged && <p className="field-hint" role="status">There are no changes to save.</p>}
      <button className="primary-button" type="submit">{workspace.busy ? 'Saving…' : event ? 'Save draft changes' : 'Save new draft'}<span aria-hidden="true">→</span></button>
      {event && <button className="text-button" type="button" onClick={cancel}>Cancel editing / start a new draft</button>}
    </fieldset></form><p className="workspace-aside-note">Saved changes appear after a fresh server check. Refreshing or changing pages clears unsaved edits. If someone else edits the same field, the later saved value wins.</p></>;
}
