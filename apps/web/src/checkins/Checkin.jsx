import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';
import { showRequest } from '../shows/client.js';
import { createCheckinStore } from './store.js';
import { CameraInput } from './CameraInput.jsx';
import './checkin.css';

export function Checkin() {
  const auth = useAuth(), params = useParams();
  return <CheckinContext key={[auth.session.user.id, auth.session.csrfToken, params.organizationId, params.eventId, params.showId].join(':')}
    auth={auth} {...params} />;
}
function CheckinContext({ auth, organizationId, eventId, showId }) {
  const [context, setContext] = useState(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true; const controller = new AbortController(); setContext(null); setError('');
    showRequest('detail', { organizationId, eventId, showId, signal: controller.signal }).then(value => {
      if (current) setContext(value);
    }).catch(error => {
      if (current) { setError(error.message); if (error.status === 401) void auth.refresh(); }
    });
    return () => { current = false; controller.abort(); };
  }, [organizationId, eventId, showId, attempt, auth.refresh]);
  const back = `/organizers/${organizationId}/events/${eventId}/shows/${showId}`;
  if (!context) return <main id="main" className="workspace-page checkin-page"><Link className="workspace-back" to={back}>Back to show</Link>
    <h1 tabIndex="-1">The entrance register.</h1>{error ? <><p role="alert">{error}</p><button className="secondary-button" onClick={() => setAttempt(v => v + 1)}>Check show access</button></>
      : <p role="status">Checking this show and your staff access.</p>}</main>;
  return <Entrance auth={auth} context={context} organizationId={organizationId} showId={showId} back={back} />;
}
function Entrance({ auth, context, organizationId, showId, back }) {
  const store = useMemo(() => createCheckinStore({ userId: auth.session.user.id, organizationId, showId,
    csrfToken: auth.session.csrfToken, onAuthRequired: auth.refresh }), [auth.session.user.id, organizationId, showId, auth.session.csrfToken, auth.refresh]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot), [credential, setCredential] = useState(''), [cameraVersion, setCameraVersion] = useState(0);
  const input = useRef(null), feedback = useRef(null), active = useRef(true);
  useEffect(() => {
    active.current = true; store.start();
    const leave = () => { store.leave(); setCredential(''); };
    window.addEventListener('blur', leave); window.addEventListener('pagehide', leave);
    const visibility = () => { if (document.visibilityState !== 'visible') leave(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { active.current = false; store.cancel(); window.removeEventListener('blur', leave); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', visibility); };
  }, [store]);
  useEffect(() => { if (state.error || state.receipt) feedback.current?.focus(); else if (state.stage === 'ready') input.current?.focus(); }, [state.error, state.receipt, state.stage]);
  const busy = ['loading', 'submitting', 'recovering'].includes(state.stage), receipt = state.receipt;
  const open = context.event.status === 'PUBLISHED' && context.status === 'SCHEDULED';
  const canSubmit = !busy && ['ready', 'pending'].includes(state.stage) && (open || Boolean(state.pending));
  async function submit(event) {
    event.preventDefault(); setCameraVersion(value => value + 1); const value = credential.trim(); setCredential('');
    await store.submit(value);
    if (active.current) setCredential('');
  }
  return <main id="main" className="workspace-page checkin-page">
    <Link className="workspace-back" to={back}>Back to show</Link>
    <header className="entrance-heading"><div><p className="eyebrow">SEATLEDGER / AT THE DOOR</p><h1 tabIndex="-1">The entrance<br /><em>register.</em></h1></div>
      <div className="entrance-edition"><span>{context.organization.name}</span><strong>{context.event.title}</strong>
        <time dateTime={context.startsAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(context.startsAt))}</time><small>Device-local time / {context.organization.role}</small></div></header>
    <p className="entrance-demo">SIMULATED ADMISSION · No real payment. New check-ins close at the show start; the server decides.</p>
    <div className="entrance-layout"><section className="entrance-desk" aria-labelledby="scan-title" aria-busy={busy}>
      <p className="eyebrow">01 / TICKET CHECK</p><h2 id="scan-title">One ticket at a time.</h2>
      {!open && <p className="entrance-warning">This show is not open for new check-ins. An existing request can still be recovered.</p>}
      {state.pending && <div className="entrance-pending"><strong>Keep the original request.</strong><p>Its result needs confirmation. Paste the same ticket to retry, or check its recorded outcome. A missing receipt does not mean it failed.</p>
        <dl><dt>REQUEST</dt><dd>{state.pending.requestKey}</dd><dt>TICKET</dt><dd>{state.pending.ticketId}</dd></dl>
        <button className="secondary-button" disabled={busy} onClick={() => { setCameraVersion(value => value + 1); setCredential(''); void store.recover(); }}>Check recorded outcome</button></div>}
      <CameraInput disabled={!canSubmit} expectedTicketId={state.pending?.ticketId} stopVersion={cameraVersion}
        onStart={() => setCredential('')} onCode={value => { setCredential(value); input.current?.focus(); }} />
      <form onSubmit={submit} autoComplete="off"><label htmlFor="admission-credential">Admission credential</label>
        <p id="credential-hint">Ask the customer to reveal their private ticket QR or code. Scan it above or paste the complete code here. Then check & admit explicitly.</p>
        <textarea ref={input} id="admission-credential" name="admission-credential" rows="3" maxLength="84" spellCheck={false} autoCapitalize="none" autoCorrect="off" autoComplete="off"
          aria-describedby="credential-hint" value={credential} disabled={!canSubmit} onChange={e => { setCameraVersion(value => value + 1); setCredential(e.target.value); }} />
        <div className="entrance-form-actions"><button className="primary-button" type="submit" disabled={!canSubmit || !credential.trim()}>{state.stage === 'submitting' ? 'Recording check-in…' : state.pending ? 'Retry original check-in' : 'Check & admit ticket'}</button>
          <button className="text-button" type="button" disabled={!credential} onClick={() => { setCameraVersion(value => value + 1); setCredential(''); input.current?.focus(); }}>Clear code</button></div></form>
      {(state.error || receipt) && <section ref={feedback} tabIndex="-1" role={state.error ? 'alert' : 'status'} className={'entrance-result ' + (receipt?.admissionGranted ? 'entrance-admitted' : 'entrance-review')}>
        {receipt && <><p className="eyebrow">{receipt.admissionGranted ? 'NEW CHECK-IN RECORDED' : 'HISTORICAL RECEIPT'}</p><h2>{receipt.admissionGranted ? 'Admit this ticket.' : 'Already recorded.'}</h2>
          <p>{receipt.admissionGranted ? 'This ticket has just been checked in.' : 'This confirms an earlier check-in. It does not authorize another entry. Resolve any uncertainty with the entrance lead.'}</p>
          <p className="entrance-seat">{receipt.checkin.section} / Row {receipt.checkin.row} / Seat {receipt.checkin.number}</p>
          <p><time dateTime={receipt.checkin.checkedAt}>{new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(receipt.checkin.checkedAt))}</time> · Device-local time</p></>}
        {state.error && <p>{state.error}</p>}
        {receipt && !state.pending && <button className="secondary-button" onClick={() => { setCredential(''); store.next(); }}>Ready for next ticket</button>}
      </section>}
      {state.stage === 'recovering' && <p role="status">Reading the original request. No new check-in is being sent.</p>}
    </section><aside className="entrance-instructions"><p className="eyebrow">02 / ENTRANCE NOTES</p><h2>A clear decision.<br />A calm queue.</h2>
      <ol><li>Check that the selected performance above is the one at this door.</li><li>Use “Admit this ticket” only for a new check-in just recorded here.</li><li>An already-used ticket or historical receipt never grants another entry.</li></ol>
      <p>Codes stay out of browser storage. Only an unresolved request and ticket identity are kept in this tab for recovery. Closing the tab can lose that shortcut.</p>
      <p>After a disconnect, keep the same request. Do not create a second scan to guess what happened.</p><span className="entrance-stub">LOCAL EDITION / ENTRANCE DESK</span></aside></div>
  </main>;
}
