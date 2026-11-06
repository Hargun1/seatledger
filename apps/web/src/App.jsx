import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { loginInput, registerInput } from '@seatledger/shared';
import { useAuth } from './auth/AuthProvider.jsx';
import { Organizations, EventsWorkspace } from './organizers/Workspace.jsx';
import { AdminReview } from './admin/Review.jsx';
import { VenueDirectory, VenueDetail } from './venues/Venues.jsx';
import { ShowDirectory, ShowDetail } from './shows/Shows.jsx';
import { Publication } from './publication/Publication.jsx';
import { Discovery, EventProgramme, PublicSeating } from './discovery/Discovery.jsx';
import { Booking } from './reservations/Booking.jsx';
import { bookingReturnPath } from './reservations/model.js';

const Checkout = lazy(() => import('./payments/Checkout.jsx').then(module => ({ default: module.Checkout })));
const PaymentHistory = lazy(() => import('./payments/History.jsx').then(module => ({ default: module.PaymentHistory })));
const Receipts = lazy(() => import('./bookings/Receipts.jsx').then(module => ({ default: module.Receipts })));
const Checkin = lazy(() => import('./checkins/Checkin.jsx').then(module => ({ default: module.Checkin })));
const Operations = lazy(() => import('./organizers/Operations.jsx').then(module => ({ default: module.Operations })));
const EventCancellation = lazy(() => import('./organizers/EventCancellation.jsx').then(module => ({ default: module.EventCancellation })));
const PrintableTickets = lazy(() => import('./bookings/PrintableTickets.jsx').then(module => ({ default: module.PrintableTickets })));

class CheckoutBoundary extends React.Component {
  state = { failed: false };
  heading = React.createRef();
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    document.title = 'SeatLedger - Reopen '+(this.props.context||'checkout');
    this.heading.current?.focus();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const entrance = this.props.context === 'entrance register';
    const printable = this.props.context === 'printable tickets';
    return <main id="main" className="message-page"><p className="eyebrow">YOUR SEATLEDGER ACCOUNT</p>
      <h1 tabIndex="-1" ref={this.heading}>Let's reopen<br /><em>{this.props.context||'checkout'}.</em></h1>
      <p role="alert">{printable ? 'The private ticket page could not be displayed.' : 'This page could not be displayed. Your request may still be processing.'}</p>
      <p>{printable ? 'Reload this address to refresh your owned tickets before printing.' : entrance ? 'Reload this same address to recover the recorded outcome. Reloading never automatically admits a ticket.' : 'Reload this same address to check it. Reloading does not automatically start another payment.'}</p>
      <button className="primary-button" onClick={() => window.location.reload()}>Reload page</button>
      <p><Link to={entrance ? '/organizers' : '/events'}>{entrance ? 'Return to organizer workspaces' : 'Return to the programme'}</Link></p></main>;
  }
}

function RouteFocus() {
  const { pathname } = useLocation();
  useEffect(() => {
    const titles = { '/': 'The local programme', '/events': 'The local programme', '/sign-in': 'Sign in', '/sign-up': 'Create an account', '/account': 'Your account', '/admin/organizers': 'Organization review' };
    document.title = `SeatLedger - ${titles[pathname] || (pathname==='/account/payments' ? 'Your payments' : pathname.startsWith('/account/bookings') ? 'Your bookings' : pathname.startsWith('/organizers') ? 'Organizer workspace' : pathname.startsWith('/events/') ? 'Event programme' : 'Page not found')}`;
    document.querySelector('main h1')?.focus();
  }, [pathname]);
  return null;
}

export function App() {
  const auth = useAuth();
  const { pathname } = useLocation();
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="demo">DEMONSTRATION ONLY · Simulated payments. No real money.</div>
    <header className="site-header">
      <Link className="wordmark" to="/" aria-label="SeatLedger home">seatledger<span>®</span></Link>
      <nav aria-label="Main navigation"><span className="edition">BENGALURU / LOCAL EDITION</span>
        <Link className="nav-programme" to="/events">Programme</Link>
        <Link className="nav-account" to={auth.status === 'authenticated' ? '/account' : '/sign-in'}>
          {auth.status === 'authenticated' ? 'Your account' : 'Sign in'} <span aria-hidden="true">↗</span>
        </Link>
      </nav>
    </header>
    <RouteFocus />
    <Routes>
      <Route path="/" element={<Discovery />} />
      <Route path="/events" element={<Discovery />} />
      <Route path="/events/:eventId" element={<EventProgramme />} />
      <Route path="/events/:eventId/shows/:showId/seats" element={<PublicSeating />} />
      <Route path="/events/:eventId/shows/:showId/reserve" element={<SessionBoundary><Booking /></SessionBoundary>} />
      <Route path="/events/:eventId/shows/:showId/checkout/:reservationId" element={<SessionBoundary><CheckoutBoundary key={pathname}><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening checkout.</h1><p role="status">Loading your checkout page.</p></main>}><Checkout /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/sign-in" element={<SessionBoundary guest><Credentials key="login" /></SessionBoundary>} />
      <Route path="/sign-up" element={<SessionBoundary guest><Credentials key="register" register /></SessionBoundary>} />
      <Route path="/account" element={<SessionBoundary><Account /></SessionBoundary>} />
      <Route path="/account/payments" element={<SessionBoundary><CheckoutBoundary key={pathname} context="payments"><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening your payments.</h1><p role="status">Loading payment history.</p></main>}><PaymentHistory /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/account/bookings" element={<SessionBoundary><CheckoutBoundary key={pathname} context="bookings"><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening your bookings.</h1></main>}><Receipts /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/account/bookings/:bookingId" element={<SessionBoundary><CheckoutBoundary key={pathname} context="bookings"><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening your booking.</h1></main>}><Receipts /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/account/bookings/:bookingId/tickets/print" element={<SessionBoundary><CheckoutBoundary key={pathname} context="printable tickets"><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening private printable tickets.</h1></main>}><PrintableTickets /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/organizers" element={<SessionBoundary><Organizations /></SessionBoundary>} />
      <Route path="/organizers/:organizationId" element={<SessionBoundary><EventsWorkspace /></SessionBoundary>} />
      <Route path="/organizers/:organizationId/venues" element={<SessionBoundary><VenueDirectory /></SessionBoundary>} />
      <Route path="/organizers/:organizationId/venues/:venueId" element={<SessionBoundary><VenueDetail /></SessionBoundary>} />
      <Route path="/organizers/:organizationId/events/:eventId/shows" element={<SessionBoundary><ShowDirectory /></SessionBoundary>} />
      <Route path="/organizers/:organizationId/events/:eventId/cancellation" element={<SessionBoundary><CheckoutBoundary key={pathname} context="event cancellation"><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening event progress.</h1></main>}><EventCancellation /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/organizers/:organizationId/events/:eventId/shows/:showId" element={<SessionBoundary><ShowDetail /></SessionBoundary>} />
      <Route path="/organizers/:organizationId/events/:eventId/shows/:showId/operations" element={<SessionBoundary><CheckoutBoundary key={pathname} context="show operations"><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening show operations.</h1><p role="status">Loading the organizer report.</p></main>}><Operations /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/organizers/:organizationId/events/:eventId/shows/:showId/check-in" element={<SessionBoundary><CheckoutBoundary key={pathname} context="entrance register"><Suspense fallback={<main id="main" className="message-page"><h1 tabIndex="-1">Opening the entrance register.</h1></main>}><Checkin key={pathname} /></Suspense></CheckoutBoundary></SessionBoundary>} />
      <Route path="/organizers/:organizationId/events/:eventId/publication" element={<SessionBoundary><Publication /></SessionBoundary>} />
      <Route path="/admin/organizers" element={<SessionBoundary><AdminReview /></SessionBoundary>} />
      <Route path="*" element={<main id="main" className="message-page"><p className="eyebrow">A WRONG TURN</p><h1 tabIndex="-1">This page is<br />{' '}<em>offstage.</em></h1><p>The address does not lead to a SeatLedger page.</p><Link className="primary-link" to="/">Back to the beginning <span aria-hidden="true">↗</span></Link></main>} />
    </Routes>
    <footer><span>BUILT FOR THE MOMENT. RESERVED WITH CARE.</span><span>LOCAL EDITION / NO. 01</span></footer>
  </>;
}

function SessionBoundary({ guest = false, children }) {
  const auth = useAuth();
  const location = useLocation(), returnTo = bookingReturnPath(new URLSearchParams(location.search).get('returnTo'));
  useEffect(() => { document.querySelector('main h1')?.focus(); }, [auth.status]);
  if (auth.status === 'loading' || auth.status === 'error') return <main id="main" className="message-page" aria-busy={auth.status === 'loading'}>
    <p className="eyebrow">YOUR SEATLEDGER ACCOUNT</p><h1 tabIndex="-1">{auth.status === 'loading' ? 'One moment.' : 'Let’s reconnect.'}</h1>
    {auth.status === 'loading' ? <p role="status">{auth.waking ? 'The box office is starting up. This can take about a minute. We’ll keep checking automatically.' : 'Checking your session…'}</p> : <><p role="alert">{auth.error}</p><button className="primary-button" onClick={() => auth.refresh()}>Check session <span aria-hidden="true">↻</span></button></>}
  </main>;
  if (guest && auth.status === 'authenticated') return <Navigate to={returnTo || '/account'} replace />;
  if (!guest && auth.status === 'anonymous') {
    const destination = bookingReturnPath(location.pathname);
    return <Navigate to={'/sign-in' + (destination ? '?returnTo=' + encodeURIComponent(destination) : '')} replace />;
  }
  return children;
}

function Credentials({ register = false }) {
  const auth = useAuth();
  const location = useLocation(), returnTo = bookingReturnPath(new URLSearchParams(location.search).get('returnTo'));
  const returnSearch = returnTo ? '?returnTo=' + encodeURIComponent(returnTo) : '';
  const [fields, setFields] = useState({ email: '', password: '', displayName: '' });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const failureRef = useRef(null), formRef = useRef(null), locked = useRef(false);
  useEffect(() => { if (failure) failureRef.current?.focus(); }, [failure]);
  const change = event => {
    setFields(value => ({ ...value, [event.target.name]: event.target.value }));
    setErrors(value => ({ ...value, [event.target.name]: '' }));
    setFailure('');
  };
  async function submit(event) {
    event.preventDefault();
    if (locked.current) return;
    const input = register ? fields : { email: fields.email, password: fields.password };
    const parsed = (register ? registerInput : loginInput).safeParse(input);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) {
        const name = issue.path[0];
        next[name] = name === 'email' ? 'Enter a valid email address (up to 254 characters).'
          : name === 'displayName' ? 'Enter a name between 1 and 120 characters.'
          : register ? 'Use 15–128 characters and no more than 256 UTF-8 bytes.' : 'Enter your password (up to 128 characters / 256 UTF-8 bytes).';
      }
      setErrors(next);
      const first = ['displayName', 'email', 'password'].find(name => next[name]);
      formRef.current.elements.namedItem(first)?.focus();
      return;
    }
    locked.current = true;
    setFailure('');
    try { await auth.mutate(register ? 'register' : 'login', parsed.data); }
    catch (error) {
      setFields(value => ({ ...value, password: '' }));
      setFailure(error.message);
    } finally { locked.current = false; }
  }
  return <main id="main" className="auth-page">
    <section className="auth-story"><p className="eyebrow">{register ? 'YOUR NEXT EVENING, SORTED' : 'GOOD TO SEE YOU AGAIN'}</p>
      <h1 tabIndex="-1">{register ? <>A place<br />{' '}for <em>you.</em></> : <>Welcome<br />{' '}<em>back.</em></>}</h1>
      <p className="lede">{register ? 'Make an account today, and explore the local programme.' : 'A small step back to the moments worth showing up for.'}</p>
      <div className="story-bottom"><span className="story-number" aria-hidden="true">01</span><p>THE DOORS ARE OPEN.<br />THE PROGRAMME IS OPEN.</p></div>
    </section>
    <section className="form-panel" aria-labelledby="form-title"><div className="panel-kicker"><span>SEATLEDGER / ACCOUNTS</span><span aria-hidden="true">↗</span></div>
      <h2 id="form-title">{register ? 'Create your account' : 'Sign in'}</h2><p className="panel-description">{register ? 'Just the essentials. A name, an email, a good passphrase.' : 'Use the email and password you registered with.'}</p>
      {auth.notice && <p className="notice" role="status">{auth.notice}</p>}
      {failure && <p className="form-error" ref={failureRef} tabIndex="-1" role="alert">{failure}</p>}
      <form onSubmit={submit} noValidate ref={formRef} aria-busy={auth.busy}>
        <fieldset disabled={auth.busy}>
          {register && <Field name="displayName" label="Your name" autoComplete="name" value={fields.displayName} onChange={change} error={errors.displayName} />}
          <Field name="email" label="Email address" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} value={fields.email} onChange={change} error={errors.email} />
          <div className="password-field"><Field name="password" label="Password" type={showPassword ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} value={fields.password} onChange={change} error={errors.password} hint={register ? '15–128 characters. Spaces are welcome; try a memorable passphrase.' : undefined} />
            <button className="password-toggle" type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide' : 'Show'}</button></div>
          <button className="primary-button" type="submit">{auth.busy ? (register ? 'Creating account…' : 'Signing in…') : (register ? 'Create account' : 'Sign in')}<span aria-hidden="true">↗</span></button>
        </fieldset>
      </form>
      <p className="switch-form">{register ? 'Already have an account?' : 'New to SeatLedger?'} <Link to={(register ? '/sign-in' : '/sign-up') + returnSearch}>{register ? 'Sign in' : 'Create an account'}</Link></p>
      <p className="panel-footnote">{register ? 'This local demo does not verify email ownership. Use a password you do not use elsewhere.' : 'Password recovery is not available in this local demo.'}</p>
    </section>
  </main>;
}

function Field({ name, label, error, hint, ...props }) {
  return <div className="field"><label htmlFor={name}>{label}</label>
    <input id={name} name={name} required aria-invalid={Boolean(error)} aria-describedby={[hint && `${name}-hint`, error && `${name}-error`].filter(Boolean).join(' ') || undefined} {...props} />
    {hint && <p className="field-hint" id={`${name}-hint`}>{hint}</p>}
    {error && <p className="field-error" id={`${name}-error`}>{error}</p>}
  </div>;
}

function Account() {
  const auth = useAuth();
  const [failure, setFailure] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const failureRef = useRef(null), allDevicesRef = useRef(null);
  useEffect(() => { if (failure) failureRef.current?.focus(); }, [failure]);
  const { user, expiresAt } = auth.session;
  async function signOut(all) {
    setFailure('');
    try { await auth.mutate(all ? 'logout-all' : 'logout'); }
    catch (error) { setFailure(error.message); }
  }
  return <main id="main" className="account-page">
    <section className="account-intro"><p className="eyebrow">YOUR SEATLEDGER ACCOUNT</p><h1 tabIndex="-1">You’re<br />{' '}<em>in.</em></h1><p className="lede">Hello, {user.displayName}. Your next good evening starts here.</p><Link className="quiet-link" to="/">Back to SeatLedger <span aria-hidden="true">↗</span></Link></section>
    <section className="account-panel" aria-labelledby="account-details"><div className="panel-kicker"><span>ACCOUNT DETAILS</span><span className="signed-in-label">SIGNED IN</span></div><h2 id="account-details">Your details</h2>
      <dl className="account-details"><div><dt>NAME</dt><dd>{user.displayName}</dd></div><div><dt>EMAIL ADDRESS</dt><dd>{user.email}</dd></div><div><dt>SESSION ENDS</dt><dd><time dateTime={expiresAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(expiresAt))}</time><span className="field-hint">In your device’s local time</span></dd></div></dl>
      <div className="programme-note"><p className="eyebrow">YOUR NEXT EVENING</p><h3>Find a place in the room.</h3><p>Explore the programme and choose seats to hold. Your bookings keeps confirmed and cancelled receipts available after checkout. Your payments finds saved attempts and reopens checkout for pending outcomes or refund progress. Open a saved booking to issue or recover simulated admission tickets. Organizer staff can open the entrance register from their show workspace.</p></div>
      <Link className="workspace-account-link" to="/account/bookings">Your bookings & saved receipts</Link>
      <Link className="workspace-account-link" to="/account/payments">Your payments & refund recovery</Link>
      <Link className="workspace-account-link" to="/events">Explore the programme</Link>
      <Link className="workspace-account-link" to="/organizers">Organize an evening <span aria-hidden="true">↗</span></Link>
      {user.role === 'ADMIN' && <Link className="workspace-account-link" to="/admin/organizers">Review organizations <span aria-hidden="true">↗</span></Link>}
      {failure && <p className="form-error" role="alert" tabIndex="-1" ref={failureRef}>{failure}</p>}
      <div className="session-actions" aria-busy={auth.busy}>
        <button className="primary-button" disabled={auth.busy} onClick={() => signOut(false)}>{auth.busy ? 'Signing out…' : 'Sign out'}<span aria-hidden="true">↗</span></button>
        <button className="text-button" ref={allDevicesRef} aria-expanded={confirmAll} aria-controls="all-devices-confirmation" disabled={auth.busy} onClick={() => setConfirmAll(value => !value)}>Sign out on all devices <span aria-hidden="true">↗</span></button>
        {confirmAll && <div className="confirm-all" id="all-devices-confirmation"><p>End every active session, including this one?</p><div><button className="secondary-button" disabled={auth.busy} onClick={() => signOut(true)}>Yes, sign out everywhere</button><button className="quiet-button" disabled={auth.busy} onClick={() => { setConfirmAll(false); allDevicesRef.current?.focus(); }}>Keep sessions</button></div></div>}
      </div>
    </section>
  </main>;
}

