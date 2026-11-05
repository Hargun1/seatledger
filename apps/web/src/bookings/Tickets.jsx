import React,{useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {useAuth} from '../auth/AuthProvider.jsx';
import {ticketRequest} from './tickets.js';
import {PrivateTicketCode} from './TicketQr.jsx';
export function Tickets({booking}){
 const auth=useAuth(),version=useRef(0),reading=useRef(null),writing=useRef(false),heading=useRef(null);
 const [state,setState]=useState({loading:true,data:null,error:''});
 const options={bookingId:booking.id,showId:booking.showId,seatIds:booking.items.map(s=>s.id)};
 function load(){if(writing.current)return;const own=++version.current;reading.current?.abort();const abort=new AbortController();reading.current=abort;setState({loading:true,data:null,error:''});
  ticketRequest({...options,signal:abort.signal}).then(data=>{if(own===version.current&&!abort.signal.aborted)setState({loading:false,data,error:''});}).catch(()=>{if(own===version.current&&!abort.signal.aborted)setState({loading:false,data:null,error:'Tickets could not be checked. Refresh to recover their current status.'});});}
 useEffect(()=>{load();return()=>{++version.current;reading.current?.abort();};},[booking.id]);
 async function issue(){if(writing.current)return;writing.current=true;const own=++version.current;reading.current?.abort();const abort=new AbortController();reading.current=abort;setState({loading:true,data:null,error:''});
  try{await ticketRequest({...options,issue:true,csrfToken:auth.session.csrfToken,signal:abort.signal});if(own!==version.current)return;
   writing.current=false;load();
  }catch{if(own===version.current)setState({loading:false,data:null,error:'Issuance was not confirmed. Refresh to recover existing tickets, or retry issuance for this same booking. No additional payment is started.'});}
  finally{writing.current=false;}
 }
 return <section className="receipt-tickets" aria-labelledby="admission-heading"><h3 id="admission-heading" ref={heading}>Admission tickets / simulated</h3>
  <p>Keep credentials and QR codes private. Staff scan or paste them in the show's entrance register, then verify live status. Paper/PDF copies still require that check at the door.</p>
  {state.loading&&<p role="status">Checking tickets.</p>}{state.error&&<p role="alert">{state.error}</p>}
  {state.data?.tickets.map(t=><article key={t.id}><p><strong>{t.section} / row {t.row}, seat {t.number}</strong> — {t.status}</p>
   {t.credential?<PrivateTicketCode credential={t.credential}/>:<p>This credential is not available for admission.</p>}</article>)}
  <button className="secondary-button" disabled={state.loading} onClick={load}>Refresh ticket status</button>{booking.status==='CONFIRMED'&&<button className="secondary-button" disabled={state.loading} onClick={issue}>Issue or recover tickets</button>}
  {booking.status==='CONFIRMED'&&state.data?.tickets.some(t=>t.status==='ISSUED')&&<p><Link className="quiet-link" to={'/account/bookings/'+booking.id+'/tickets/print'}>Open private printable tickets</Link></p>}
 </section>;
}
