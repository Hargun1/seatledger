import React,{useEffect,useRef,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {useAuth} from '../auth/AuthProvider.jsx';
import {canonicalId} from '../payments/model.js';
import {priceLabel,utcWhen} from '../discovery/model.js';
import {operationsRequest,OperationsError,reportMinor} from './operations.js';
import './operations.css';

export function Operations(){
  const {organizationId,eventId,showId}=useParams(),auth=useAuth(),scope={organizationId,eventId,showId};
  if(!Object.values(scope).every(canonicalId))return <main id="main" className="message-page"><h1 tabIndex="-1">Report unavailable.</h1><Link to="/organizers">Organizer workspaces</Link></main>;
  return <ReportAccount key={`${auth.session.user.id}:${organizationId}:${eventId}:${showId}`} scope={scope}/>;
}
function ReportAccount({scope}){const [cursor,setCursor]=useState(undefined);return <ReportPage key={cursor||'newest'} scope={scope} cursor={cursor} onCursor={setCursor}/>;}
function ReportPage({scope,cursor,onCursor}){
  const auth=useAuth(),generation=useRef(0),reading=useRef(null),exporting=useRef(null),refresh=useRef(null),urls=useRef(new Set()),heading=useRef(null);
  const [state,setState]=useState({loading:true,summary:null,roster:null,error:null}),[download,setDownload]=useState({busy:false,message:''});
  const {organizationId,eventId,showId}=scope;
  useEffect(()=>{
    const load=async()=>{
      const own=++generation.current;reading.current?.abort();exporting.current?.abort();exporting.current=null;
      const current=new AbortController();reading.current=current;setState({loading:true,summary:null,roster:null,error:null});setDownload({busy:false,message:''});
      try{const [summary,roster]=await Promise.all([operationsRequest('summary',{...scope,signal:current.signal}),operationsRequest('bookings',{...scope,cursor,signal:current.signal})]);
        if(own!==generation.current||current.signal.aborted)return;
        if(summary.organization.role!==roster.organization.role)throw new OperationsError();
        setState({loading:false,summary,roster,error:null});
      }catch(error){if(own===generation.current&&!current.signal.aborted)setState({loading:false,summary:null,roster:null,error});}
    };
    refresh.current=load;document.title='SeatLedger - Show operations';heading.current?.focus();load();
    const focus=()=>{if(document.visibilityState==='visible')load();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{++generation.current;reading.current?.abort();exporting.current?.abort();refresh.current=null;for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[organizationId,eventId,showId,cursor]);
  async function exportPage(){
    if(exporting.current||state.loading||!state.roster)return;
    const own=generation.current,current=new AbortController();exporting.current=current;setDownload({busy:true,message:''});
    try{const result=await operationsRequest('export',{...scope,cursor,role:state.roster.organization.role,signal:current.signal});
      if(own!==generation.current||current.signal.aborted)return;
      const url=URL.createObjectURL(new Blob([result.csv],{type:'text/csv;charset=utf-8'}));urls.current.add(url);
      const anchor=document.createElement('a');anchor.href=url;anchor.download=`seatledger-bookings-${showId}.csv`;document.body.appendChild(anchor);anchor.click();anchor.remove();
      setTimeout(()=>{URL.revokeObjectURL(url);urls.current.delete(url);},1000);
      setDownload({busy:false,message:`Download requested for ${result.rowCount} rows, snapshot ${utcWhen(result.asOf)}. This export covers this page only.`});
    }catch(error){if(own===generation.current&&!current.signal.aborted)setDownload({busy:false,message:error instanceof OperationsError?error.message:'The export could not be prepared.'});}
    finally{if(exporting.current===current)exporting.current=null;}
  }
  const {summary,roster}=state,showPath=`/organizers/${organizationId}/events/${eventId}/shows/${showId}`;
  return <main id="main" className="discovery-page operations-page"><Link className="programme-back" to={showPath}>Saved show workspace</Link>
    <header><p className="eyebrow">SEATLEDGER / ORGANIZER LEDGER</p><h1 tabIndex="-1" ref={heading}>A room,<br/><em>accounted for.</em></h1><p>Bookings, attendance and simulated payment records for this show.</p></header>
    <div className="operations-toolbar"><button className="secondary-button" disabled={state.loading} onClick={()=>refresh.current?.()}>Refresh report</button><Link className="quiet-link" to={showPath+'/check-in'}>Entrance register</Link></div>
    <p><Link className="quiet-link" to={`/organizers/${organizationId}/events/${eventId}/cancellation`}>Whole-event cancellation & recovery</Link></p>
    {state.loading&&<p role="status">Checking organizer access and current show records.</p>}
    {state.error&&<div className="operations-error" role="alert"><p>{state.error instanceof OperationsError?state.error.message:'The show report could not be checked.'}</p>
      {[401,403].includes(state.error?.status)&&<button className="secondary-button" onClick={()=>auth.refresh()}>Check session</button>}</div>}
    {summary&&roster&&<><h2>{summary.event.title}</h2><p>{summary.organization.name} / {summary.organization.role} / {summary.show.status}</p>
      <p className="operations-caption">Summary snapshot: <time dateTime={summary.asOf}>{utcWhen(summary.asOf)}</time>. Show starts {utcWhen(summary.show.startsAt)}.</p>
      <dl className="operations-metrics">{[
        ['Confirmed bookings',summary.bookings.confirmed],['Cancelled bookings',summary.bookings.cancelled],['Confirmed seats',summary.attendance.confirmedSeats],['Historical admissions',summary.attendance.checkedInSeats],
        ['Available stock',summary.inventory.available],['Held stock',summary.inventory.held],['Booked stock',summary.inventory.booked],['Expired holds awaiting reclaim',summary.inventory.expiredHolds]
      ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="operations-caption">Stock states are saved current allocation rows; held stock includes expired holds. History and stock are separate facts. Admission counts include recorded history.</p>
      <section><h3>Simulated capture & refund records</h3>{summary.financials===null?<p>Financial amounts are available to owners only.</p>:<>
        {!summary.financials.length&&<p>No successful captures recorded for this show.</p>}
        {summary.financials.map(m=><div className="operations-money" key={m.currency}><h4>{m.currency}</h4><dl>
          <div><dt>All successful captures</dt><dd>{reportMinor(m.capturedMinor,m.currency)}</dd></div><div><dt>Confirmed business refunds</dt><dd>{reportMinor(m.confirmedRefundMinor,m.currency)}</dd></div>
          <div><dt>Unconfirmed refund requests</dt><dd>{reportMinor(m.unconfirmedRefundMinor,m.currency)}</dd></div><div><dt>Refunds needing review</dt><dd>{m.refundReviewCount}</dd></div></dl></div>)}
        <p className="operations-caption">Exact integer minor units, grouped by currency. Captures include duplicate/late payments. These are simulated ledger totals; they are not profit or a cash balance.</p></>}</section>
      <section><div className="operations-toolbar"><h3>Saved bookings & attendance</h3><button className="secondary-button" disabled={download.busy} onClick={exportPage}>{download.busy?'Preparing page export.':'Download this page as CSV'}</button></div>
        <p className="operations-caption">Roster snapshot: {utcWhen(roster.asOf)}. Export reads a fresh page at the same cursor, up to 20 rows, so it may differ from this display. Customer names are current; seat labels and prices are saved booking facts.</p>
        {download.message&&<p role="status">{download.message}</p>}
        <ol className="operations-roster">{roster.items.map(b=><li key={b.id}><div><p className="eyebrow">{b.status}</p><h4>{b.customerName}</h4><p>{b.seats.length} seats / {b.checkedInSeats} admitted</p>
          <p>{b.seats.map(s=>`${s.section} / ${s.row} / ${s.number}`).join('; ')}</p>{b.totalMinor!==null&&<p>{priceLabel(b.totalMinor,b.currency)}</p>}
          <p className="operations-caption">Recorded {utcWhen(b.createdAt)}<br/>Booking reference <code>{b.id}</code></p></div></li>)}</ol>
        {!roster.items.length&&<p>No saved bookings on this page.</p>}
      </section></>}
    <nav className="operations-toolbar" aria-label="Show booking pages"><button className="secondary-button" disabled={!cursor||state.loading} onClick={()=>onCursor(undefined)}>Newest bookings</button>
      <button className="secondary-button" disabled={state.loading||!roster?.nextCursor} onClick={()=>onCursor(roster.nextCursor)}>Older bookings</button></nav>
  </main>;
}
