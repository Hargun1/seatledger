import React, { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { OrganizationNav } from '../organizers/OrganizationNav.jsx';
import { money, venueTime } from '../shows/model.js';
import { publicationRequest } from './client.js';
import { createPublicationStore } from './store.js';

function usePublication(organizationId, eventId) {
  const auth = useAuth(), userId = auth.session.user.id, csrfToken = auth.session.csrfToken;
  const store = useMemo(() => createPublicationStore({
    readStatus: options => publicationRequest('status', { ...options, organizationId, eventId }),
    readReview: options => publicationRequest('review', { ...options, organizationId, eventId }),
    publish: review => publicationRequest('publish', { organizationId, eventId, review, csrfToken }),
    onAuthRequired: auth.refresh
  }), [organizationId, eventId, userId, csrfToken, auth.refresh]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useLayoutEffect(() => () => store.cancel(), [store]);
  useEffect(() => { store.load(); return store.cancel; }, [store]);
  return { state, store, checkSession: auth.refresh };
}

export function Publication() {
  const { organizationId, eventId } = useParams(), { state, store, checkSession } = usePublication(organizationId, eventId);
  const feedback = useRef(null), reviewHeading = useRef(null), confirmHeading = useRef(null), receiptHeading = useRef(null), continueButton = useRef(null), previous = useRef(null);
  useEffect(() => {
    if (state.status === 'confirm') confirmHeading.current?.focus();
    else if (state.status === 'review') (previous.current === 'confirm' ? continueButton : reviewHeading).current?.focus();
    else if (state.status === 'record') receiptHeading.current?.focus();
    else if (state.error || state.notice) feedback.current?.focus();
    previous.current = state.status;
  }, [state.status, state.error, state.notice]);
  const schedule = `/organizers/${organizationId}/events/${eventId}/shows`;
  const review = state.review, data = state.data;
  const save = () => { store.save().catch(() => {}); }; // The store owns visible failure/recovery state.
  return <main id="main" className="workspace-page publication-page" aria-busy={state.busy}>
    <Link className="workspace-back" to={schedule}>Back to show schedule</Link>
    <header className="workspace-heading"><div><p className="eyebrow">SEATLEDGER / LOCAL PUBLICATION</p><h1 tabIndex="-1">{data?.event.title || 'Ready for the programme?'}</h1><p>Review every occurrence before creating its initial seat inventory. This updates the local demo only.</p></div>
      <button className="secondary-button" disabled={state.busy} onClick={() => store.load()}>Check publication status</button></header>
    <OrganizationNav organizationId={organizationId} />
    {(state.error || state.notice) && <div ref={feedback} tabIndex="-1" className={state.error ? 'workspace-error' : 'notice'}>
      {state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
    </div>}
    {state.status === 'loading' && <p className="workspace-loading" role="status">Checking the saved programme.</p>}
    {state.status === 'publishing' && <section className="publication-wait" role="status"><p className="eyebrow">SAVING THE WHOLE PROGRAMME</p><h2>One considered moment.</h2><p>Saving all show inventory and the publication record together. A missing response does not mean the publication failed.</p></section>}
    {['error', 'uncertain'].includes(state.status) && <section className="publication-recovery"><h2>{state.status === 'uncertain' ? 'Let’s check what was saved.' : 'The programme needs another look.'}</h2>
      <p>{state.status === 'uncertain' ? 'No publication request will be repeated automatically. A status check reads saved state; it does not rebuild inventory.' : 'Check current status, or return to the schedule to resolve the reported issue.'}</p>
      <div className="show-actions"><button className="primary-button" onClick={() => store.load()}>Read saved publication</button><Link className="workspace-event-link" to={schedule}>Open show schedule</Link><button className="text-button" onClick={checkSession}>Check session</button></div></section>}
    {state.status === 'draft' && <section className="publication-intro"><div><p className="eyebrow">DRAFT / {data.organization.role}</p><h2>The last look<br />before publication.</h2><p>Review the event title, every venue, date, price and seat count. Confirmation creates inventory for the whole programme and closes draft scheduling.</p><p>No payment is taken. Public discovery and customer booking are still being built.</p></div>
      <aside><p className="eyebrow">A SEPARATE STEP</p><h3>A review saves nothing.</h3><p>{data.organization.role === 'OWNER' ? 'Prepare the current schedule, inspect it, then choose whether to confirm.' : 'You can inspect the current schedule. Only an active owner can confirm publication.'}</p><button className="primary-button" onClick={() => store.prepare()}>Review saved schedule</button></aside></section>}
    {['review', 'confirm', 'retry'].includes(state.status) && review && <>
      <section className="publication-review" aria-labelledby="publication-review-title"><div className="publication-review-heading"><div><p className="eyebrow">{state.status === 'retry' ? 'PREVIOUSLY REVIEWED PROGRAMME' : 'SAVED PROGRAMME / REVIEW'}</p><h2 id="publication-review-title" ref={reviewHeading} tabIndex="-1">The programme, in full.</h2><p>{review.event.category}</p></div><div className="publication-count"><strong>{review.inventoryCount.toLocaleString('en-IN')}</strong><span>seats across {review.shows.length} {review.shows.length === 1 ? 'show' : 'shows'}</span></div></div>
        <ReviewShows review={review} /><p className="workspace-aside-note">These counts describe initial inventory, not live availability. Any intervening programme change requires a new review.</p></section>
      {state.status === 'review' && (review.organization.role === 'OWNER' ? <button ref={continueButton} className="primary-button publication-continue" onClick={() => store.confirm()}>Continue to confirmation</button> : <p className="workspace-copy">Staff review is read only. An active owner confirms publication.</p>)}
      {state.status === 'confirm' && <section className="layout-confirmation publication-confirm"><p className="eyebrow">CONFIRM THE REVIEWED PROGRAMME</p><h2 ref={confirmHeading} tabIndex="-1">Publish this programme locally?</h2><p>Create initial inventory for all {review.shows.length} shows and close draft edits. The server rechecks the entire reviewed programme before committing. No real money is charged.</p>
        <div className="show-actions"><button className="primary-button" onClick={save}>Confirm local publication</button><button className="secondary-button" onClick={() => store.back()}>Back to review</button></div></section>}
      {state.status === 'retry' && <section className="layout-confirmation publication-confirm"><h2>Retry the same reviewed publication?</h2><p>This sends the same reviewed intention. If the earlier attempt committed, the server returns its saved record without resetting seats. A changed draft will be refused.</p><div className="show-actions"><button className="primary-button" onClick={save}>Retry same reviewed publication</button><button className="secondary-button" onClick={() => store.discard()}>Use a fresh review instead</button></div></section>}
    </>}
    {state.status === 'record' && <section className="publication-record" aria-labelledby="publication-record-title"><div className="publication-review-heading"><div><p className="eyebrow">CURRENT EVENT / {data.event.status}</p><h2 id="publication-record-title" ref={receiptHeading} tabIndex="-1">{data.receipt ? 'Publication record.' : data.event.status === 'PUBLISHED' ? 'Already published.' : 'The programme is closed.'}</h2></div><span className={`status-label status-${data.event.status.toLowerCase()}`}>{data.event.status}</span></div>
      {data.receipt ? <><p className="workspace-copy">{data.event.status === 'CANCELLED' ? 'The event is now cancelled. The original publication record below is historical; it is not a current publication confirmation.' : 'This records a saved local publication. It is not a live seat-availability response.'}</p>
        <dl className="publication-record-summary"><div><dt>PUBLISHED AT</dt><dd><time dateTime={data.receipt.event.publishedAt}>{venueTime(data.receipt.event.publishedAt, 'UTC')} UTC</time></dd></div><div><dt>INITIAL SEAT COUNT</dt><dd>{data.receipt.inventoryCount.toLocaleString('en-IN')}</dd></div><div><dt>SHOWS</dt><dd>{data.receipt.shows.length}</dd></div></dl>
        <ul className="publication-shows">{data.receipt.shows.map(show => <li key={show.id}><div><p className="eyebrow">SAVED UTC TIME</p><h3><time dateTime={show.startsAt}>{venueTime(show.startsAt, 'UTC')} UTC</time></h3><p>{show.seatCount} initial seats · {money(show.priceMinor)} per seat</p></div><Link className="workspace-event-link" to={`${schedule}/${show.id}`}>Open saved show<span className="sr-only"> {show.id}</span></Link></li>)}</ul>
      </> : <p className="workspace-copy">{data.event.status === 'PUBLISHED' ? 'This event was published before saved publication records were available. Its existing inventory is not rebuilt here.' : 'No saved publication receipt is available for this closed event.'}</p>}
      <p className="workspace-aside-note">Published or cancelled events cannot be published again here. Refreshing this page reads current status and the saved record; it does not repeat publication.</p><Link className="workspace-event-link" to={schedule}>Return to show schedule</Link>
    </section>}
  </main>;
}
function ReviewShows({ review }) {
  return <ul className="publication-shows">{review.shows.map(show => <li key={show.id}><div><p className="eyebrow">{show.venue.city} / {show.venue.name}</p><h3><time dateTime={show.startsAt}>{venueTime(show.startsAt, show.venue.timezone)}</time></h3><p>{show.venue.timezone}</p><small>UTC: {show.startsAt}</small></div><div className="publication-show-price"><strong>{money(show.priceMinor)}</strong><span>per seat</span><p>{show.seatCount} configured seats</p></div></li>)}</ul>;
}
