import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Feedback, Pagination, WorkspaceHeading } from '../organizers/Workspace.jsx';
import { createWorkspaceStore } from '../organizers/workspace-store.js';
import { adminReviewRequest, reviewStatuses } from './client.js';

const labels = { PENDING: 'Awaiting review', APPROVED: 'Approved', SUSPENDED: 'Suspended' };
const actionLabels = { PENDING: 'Approve organization', APPROVED: 'Suspend organization', SUSPENDED: 'Reapprove organization' };

export function AdminReview() {
  const auth = useAuth();
  if (auth.session.user.role !== 'ADMIN') return <main id="main" className="message-page"><p className="eyebrow">SEATLEDGER / REVIEW DESK</p>
    <h1 tabIndex="-1">A restricted<br />review desk.</h1><p>Administrator access is required to review organization requests. Your account can still request and manage its own organization access.</p>
    <Link className="primary-link" to="/organizers">Your organizations <span aria-hidden="true">→</span></Link></main>;
  return <ReviewQueue />;
}

function ReviewQueue() {
  const auth = useAuth(), [params] = useSearchParams();
  const status = reviewStatuses.includes(params.get('status')) ? params.get('status') : 'PENDING';
  const { id: userId } = auth.session.user, csrfToken = auth.session.csrfToken;
  const store = useMemo(() => createWorkspaceStore({
    load: options => adminReviewRequest('list', { status, ...options }),
    write: (_action, decision) => adminReviewRequest('decide', { ...decision, csrfToken }),
    onAuthRequired: auth.refresh
  }), [userId, csrfToken, status, auth.refresh]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const workspace = { ...state, refresh: store.refresh, recover: auth.refresh };
  const [selection, setSelection] = useState(null);
  const trigger = useRef(null), confirmationTitle = useRef(null);
  useEffect(() => { store.refresh(); return store.cancel; }, [store]);
  useEffect(() => { setSelection(null); }, [store, state.status]);
  useEffect(() => { if (selection) confirmationTitle.current?.focus(); }, [selection]);
  const ready = state.status === 'ready';
  const selected = ready && selection?.filter === status ? selection.row : null;
  const target = selected?.status === 'APPROVED' ? 'SUSPENDED' : 'APPROVED';
  async function decide() {
    if (!selected || state.busy) return;
    try {
      await store.mutate('decide', { organizationId: selected.id, status: target, expectedVersion: selected.statusVersion },
        target === 'SUSPENDED' ? 'Organization suspended. Member event access is paused.' : 'Organization approved. Existing active members can now access events.');
    } catch { /* Store exposes safe recovery state; never replay a decision. */ }
  }
  function cancel() { setSelection(null); trigger.current?.focus(); }
  return <main id="main" className="workspace-page admin-review" aria-busy={state.busy || state.status === 'loading'}>
    <Link className="workspace-back" to="/account">← Your account</Link>
    <WorkspaceHeading workspace={workspace} eyebrow="SEATLEDGER / ADMINISTRATION" title={<>The review <em>desk.</em></>}>Consider each organization before opening its event workspace.</WorkspaceHeading>
    <nav className="review-filters" aria-label="Organization review status">{reviewStatuses.map(value => <Link key={value} to={`/admin/organizers?status=${value}`} aria-current={status === value ? 'page' : undefined}
      aria-disabled={state.busy || undefined} onClick={e => { if (state.busy) e.preventDefault(); }}>{labels[value]}</Link>)}</nav>
    <Feedback workspace={workspace} />
    {ready && <div className="workspace-grid"><section className="workspace-register" aria-labelledby="review-list-title">
      <div className="workspace-section-title"><span className="eyebrow">01 / ORGANIZATION ACCESS</span><span>ADMIN REVIEW</span></div>
      <h2 id="review-list-title">{labels[status]} organizations.</h2>
      {!state.page.items.length ? <div className="workspace-empty"><p>No organizations on this page.</p><p>Refresh to check for new requests or decisions from another reviewer.</p></div>
        : <ul className="review-list">{state.page.items.map(row => <li key={row.id}>
          <div><span className={`status-label status-${row.status.toLowerCase()}`}>{labels[row.status]}</span><h3>{row.name}</h3>
            <p className="review-reference">Reference <code>{row.id}</code></p><p className="review-created">Requested <time dateTime={row.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(row.createdAt))}</time></p></div>
          <button className={`secondary-button ${row.status === 'APPROVED' ? 'suspend-button' : ''}`} disabled={state.busy}
            aria-expanded={selected?.id === row.id} aria-controls={selected?.id === row.id ? 'review-confirmation' : undefined}
            onClick={e => { trigger.current = e.currentTarget; setSelection({ row, filter: status }); }}>{actionLabels[row.status]}<span className="sr-only">: {row.name}</span></button>
        </li>)}</ul>}
      <Pagination workspace={workspace} />
    </section><aside className="workspace-side">
      {selected ? <section id="review-confirmation" aria-labelledby="review-confirmation-title"><p className="eyebrow">02 / CONFIRM YOUR DECISION</p>
        <h2 ref={confirmationTitle} tabIndex="-1" id="review-confirmation-title">{target === 'SUSPENDED' ? 'Pause event access?' : 'Open event access?'}</h2>
        <p className="review-selected-name">{selected.name}</p><p className="workspace-copy">{labels[selected.status]} → {labels[target]}</p>
        <p className="workspace-copy">{target === 'SUSPENDED' ? 'Existing members will lose access to the event workspace. This does not cancel shows or bookings, or issue refunds.' : 'Existing active members will receive their owner or staff event access. This does not grant new memberships or administrator roles.'}</p>
        <p className="workspace-aside-note">If another reviewer changes this organization before you confirm, reload and review the new decision.</p>
        <button className={`primary-button ${target === 'SUSPENDED' ? 'suspend-button' : ''}`} disabled={state.busy} onClick={decide}>{state.busy ? 'Recording decision…' : target === 'SUSPENDED' ? 'Confirm suspension' : 'Confirm approval'}<span aria-hidden="true">→</span></button>
        <button className="text-button" disabled={state.busy} onClick={cancel}>Keep current status</button>
      </section> : <><p className="eyebrow">02 / A CONSIDERED DECISION</p><h2>Access, with<br />care.</h2><p className="workspace-copy">Select an organization to review the effect before confirming. Every saved status change is recorded in the audit history.</p>
        <p className="workspace-aside-note">Approval gives access to existing members. Imported organizations may have no members; approval does not assign them to your account. Review access does not grant event ownership.</p></>}
    </aside></div>}
  </main>;
}
