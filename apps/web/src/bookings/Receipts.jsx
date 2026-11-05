import React,{useEffect,useRef,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {useAuth} from '../auth/AuthProvider.jsx';
import {priceLabel,utcWhen} from '../discovery/model.js';
import {bookingRequest,ReceiptError} from './client.js';
import {Tickets} from './Tickets.jsx';
import {Cancellation} from './Cancellation.jsx';
import './receipts.css';

export function Receipts(){const {bookingId}=useParams(),auth=useAuth();return <ReceiptPage key={`${auth.session.user.id}:${bookingId||'list'}`} id={bookingId?.toLowerCase()}/>;}
function ReceiptPage({id}){
  const auth=useAuth(),version=useRef(0),controller=useRef(null),heading=useRef(null);
  const [state,setState]=useState({loading:true,data:null,error:null}),[cursor,setCursor]=useState(undefined),[hideTickets,setHideTickets]=useState(false);
  function load(next=cursor){const own=++version.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;
    setState({loading:true,data:null,error:null});
    bookingRequest({id,cursor:next,signal:abort.signal}).then(data=>{if(own===version.current&&!abort.signal.aborted){setHideTickets(false);setState({loading:false,data,error:null});}})
      .catch(error=>{if(own===version.current&&!abort.signal.aborted)setState({loading:false,data:null,error});});}
  useEffect(()=>{document.title='SeatLedger - Your bookings';heading.current?.focus();load();return()=>{++version.current;controller.current?.abort();};},[id,cursor]);
  const record=state.data;
  return <main id="main" className="discovery-page receipts-page"><Link className="programme-back" to={id?'/account/bookings':'/account'}>{id?'All your bookings':'Your account'}</Link>
    <header><p className="eyebrow">SEATLEDGER / YOUR BOX OFFICE</p><h1 tabIndex="-1" ref={heading}>{id?'Your booking.':'Evenings, saved.'}</h1>
      <p>Simulated bookings. No real money charged. This receipt is not an admission ticket.</p></header>
    <div className="receipt-toolbar"><span>{id?'SAVED BOOKING RECORD':'NEWEST BOOKINGS FIRST'}</span><button className="text-button" disabled={state.loading} onClick={()=>load()}>Refresh</button></div>
    {state.loading&&<p role="status">Checking your bookings.</p>}
    {state.error&&<div className="receipt-error" role="alert"><p>{state.error instanceof ReceiptError?state.error.message:'Your bookings could not be checked.'}</p>
      {[401,403].includes(state.error.status)&&<button className="secondary-button" onClick={()=>auth.refresh()}>Check session</button>}</div>}
    {record&&(id?<article className="receipt-sheet"><p className="eyebrow">{record.status} / SIMULATED</p><h2>{record.currentProgramme.title}</h2>
      <p className="receipt-context">Current programme information: {record.currentProgramme.venue}, {record.currentProgramme.city}<br/><time dateTime={record.currentProgramme.startsAt}>{utcWhen(record.currentProgramme.startsAt)}</time></p>
      {record.currentProgramme.eventStatus==='CANCELLED'&&<p role="status">This event is cancelled. Booking cleanup and refund processing may still be in progress. Admission tickets cannot be used.</p>}
      <h3>Your saved seats & prices</h3><ol>{record.items.map(s=><li key={s.id}><span>{s.section} / row {s.row}, seat {s.number}</span><strong>{priceLabel(s.priceMinor,s.currency)}</strong></li>)}</ol>
      <div className="receipt-total"><span>Saved total</span><strong>{priceLabel(record.totalMinor,record.currency)}</strong></div>
      <dl><dt>Booking reference</dt><dd><code>{record.id}</code></dd><dt>Recorded</dt><dd>{utcWhen(record.createdAt)}</dd>{record.cancelledAt&&<><dt>Cancelled</dt><dd>{utcWhen(record.cancelledAt)}</dd></>}</dl>
      <p>{record.status==='CANCELLED'?'This booking is cancelled. This page does not confirm refund completion.':'Your confirmed booking is recorded. Issue or recover its admission tickets below.'}</p>
      <p className="receipt-context">Seat labels and prices are saved booking facts. Programme details above are current catalogue information and may change.</p>
      <Cancellation key={record.id+':'+record.status} booking={record} onAttempt={()=>setHideTickets(true)} onChanged={()=>load()}/>
      {hideTickets?<p>Ticket display is paused after the cancellation request. Refresh this receipt to check the current booking and ticket status.</p>:<Tickets key={record.id+':'+record.status} booking={record}/>}
    </article>:<><ol className="receipt-history">{record.items.map(b=><li key={b.id}><div><p className="eyebrow">{b.status} / SIMULATED</p><h2><Link to={'/account/bookings/'+b.id}>{b.currentProgramme.title}</Link></h2><p>{b.seatCount} {b.seatCount===1?'seat':'seats'} / {priceLabel(b.totalMinor,b.currency)}</p><p className="receipt-context">Booked {utcWhen(b.createdAt)} · Current programme: {b.currentProgramme.venue}</p></div><Link className="quiet-link" to={'/account/bookings/'+b.id}>View saved receipt</Link></li>)}</ol>
      {!record.items.length&&<p>No confirmed or cancelled booking records were found on this page.</p>}
      <nav className="receipt-paging" aria-label="Booking history pages"><button className="secondary-button" disabled={!cursor} onClick={()=>setCursor(undefined)}>Newest bookings</button><button className="secondary-button" disabled={!record.nextCursor} onClick={()=>setCursor(record.nextCursor)}>Older bookings</button></nav></>)}
    <p><Link className="quiet-link" to="/account/payments">Your payments & refund recovery</Link></p>
  </main>;
}
