import React,{useEffect,useRef,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {useAuth} from '../auth/AuthProvider.jsx';
import {canonicalId} from '../payments/model.js';
import {utcWhen} from '../discovery/model.js';
import {eventCancellationRequest,EventCancellationError} from './event-cancellation.js';
import './operations.css';

export function EventCancellation(){
  const {organizationId,eventId}=useParams(),auth=useAuth();
  if(![organizationId,eventId].every(canonicalId))return <main id="main" className="message-page"><h1 tabIndex="-1">Cancellation unavailable.</h1><Link to="/organizers">Organizer workspaces</Link></main>;
  return <CancellationPage key={`${auth.session.user.id}:${organizationId}:${eventId}`} organizationId={organizationId} eventId={eventId}/>;
}
function CancellationPage({organizationId,eventId}){
  const auth=useAuth(),version=useRef(0),controller=useRef(null),writing=useRef(false),refresh=useRef(null),heading=useRef(null),polls=useRef(0);
  const [state,setState]=useState({loading:true,data:null,error:null}),[confirm,setConfirm]=useState(null),[uncertain,setUncertain]=useState(null);
  useEffect(()=>{
    const load=async()=>{
      if(writing.current)return;const own=++version.current;controller.current?.abort();const current=new AbortController();controller.current=current;
      setConfirm(null);setState({loading:true,data:null,error:null});
      try{const data=await eventCancellationRequest('read',{organizationId,eventId,signal:current.signal});
        if(own===version.current&&!current.signal.aborted){setState({loading:false,data,error:null});
          setUncertain(old=>old&&((old.action==='request'&&data.job!==null)||(old.action==='resume'&&data.job?.generation>old.expectedGeneration))?null:old);}
      }catch(error){if(own===version.current&&!current.signal.aborted)setState({loading:false,data:null,error});}
    };
    refresh.current=load;document.title='SeatLedger - Event cancellation';heading.current?.focus();load();
    const focus=()=>{if(document.visibilityState==='visible')load();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{++version.current;controller.current?.abort();refresh.current=null;window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[organizationId,eventId]);
  useEffect(()=>{
    if(!['PENDING','PROCESSING'].includes(state.data?.job?.status)||polls.current>=40)return;
    const timer=setTimeout(()=>{if(document.visibilityState==='visible'){polls.current++;refresh.current?.();}},3000);
    return()=>clearTimeout(timer);
  },[state.data]);
  async function send(action){
    if(writing.current||confirm!==action||!state.data||state.data.organization.role!=='OWNER')return;
    const expectedGeneration=state.data.job?.generation;writing.current=true;const own=++version.current;controller.current?.abort();const current=new AbortController();controller.current=current;
    setConfirm(null);setState({loading:true,data:null,error:null});
    try{await eventCancellationRequest(action,{organizationId,eventId,expectedGeneration,csrfToken:auth.session.csrfToken,signal:current.signal});
      if(own!==version.current||current.signal.aborted)return;writing.current=false;setUncertain(null);refresh.current?.();
    }catch(error){if(own===version.current&&!current.signal.aborted){setUncertain(error.uncertain?{action,expectedGeneration}:null);setState({loading:false,data:null,error});}}
    finally{writing.current=false;}
  }
  const data=state.data,c=data?.counts,job=data?.job,owner=data?.organization.role==='OWNER';
  const inconsistent=job?.status==='COMPLETED'&&(c.remainingBookings!==0||c.activeHolds!==0||c.remainingAllocations!==0||c.missingRefundIntents!==0);
  const action=job?.status==='NEEDS_REVIEW'?'resume':'request';
  return <main id="main" className="discovery-page operations-page"><Link className="programme-back" to={`/organizers/${organizationId}`}>Organization events</Link>
    <header><p className="eyebrow">SEATLEDGER / EVENT CANCELLATION</p><h1 tabIndex="-1" ref={heading}>Close the<br/><em>programme.</em></h1><p>Cancellation closes sales and admission. Allocation cleanup and simulated refunds are tracked separately.</p></header>
    <div className="operations-toolbar"><button className="secondary-button" disabled={state.loading} onClick={()=>refresh.current?.()}>Check progress</button><Link className="quiet-link" to={`/organizers/${organizationId}/events/${eventId}/shows`}>Show schedule</Link></div>
    {state.loading&&<p role="status">{writing.current?'Recording this event action.':'Checking current event progress.'}</p>}
    {uncertain&&<p role="status">The original action response is unconfirmed. Check progress before any explicit retry of this same event. A read cannot prove an in-flight request stopped.</p>}
    {state.error&&<div className="operations-error" role="alert"><p>{state.error instanceof EventCancellationError?state.error.message:'Event progress could not be checked.'}</p>
      {[401,403].includes(state.error?.status)&&<button className="secondary-button" onClick={()=>auth.refresh()}>Check session</button>}</div>}
    {data&&<><h2>{data.event.title}</h2><p>{data.organization.name} / {data.organization.role} / {data.event.status}</p><p className="operations-caption">Snapshot {utcWhen(data.asOf)}.</p>
      <dl className="operations-metrics">{[['Confirmed bookings left',c.remainingBookings],['Cancelled booking history',c.cancelledBookings],['Active holds left',c.activeHolds],['Allocated stock rows left',c.remainingAllocations],
        ['Refund requests',c.refundRequests],['Confirmed refunds',c.refundsCompleted],['Refunds needing review',c.refundsNeedsReview],['Missing refund intents',c.missingRefundIntents]].map(([label,n])=><div key={label}><dt>{label}</dt><dd>{n}</dd></div>)}</dl>
      {job?<section><h3>{inconsistent?'Current cleanup counts need review.':job.status==='COMPLETED'?'Allocation cleanup complete.':job.status==='NEEDS_REVIEW'?'Processing needs review.':job.status==='PENDING'?'Cancellation recorded.':'Cleanup is processing.'}</h3>
        <p>Requested {utcWhen(job.requestedAt)}{job.completedAt?` / cleanup completed ${utcWhen(job.completedAt)}`:''}.</p>
        <p>Cleanup completion means bookings and holds were closed and refund intents were queued. It does not mean every simulated refund has completed.</p>
        {c.refundsNeedsReview>0&&<p>Some refund work needs review independently of allocation cleanup.</p>}
        {job.status==='NEEDS_REVIEW'&&<p>A blocked record needs review. Resume after the underlying issue has been resolved; resuming does not repair inconsistent records.</p>}
        {['PENDING','PROCESSING'].includes(job.status)&&<p>Processing can continue when background cleanup is available. This page refreshes up to 40 times per visit; Check progress remains available.</p>}
      </section>:<p>{data.requestable?'Only a future published event with no recorded admissions can be cancelled here.':data.event.status==='CANCELLED'?'This legacy cancelled event has no tracked cleanup job and needs review.':'Cancellation is unavailable: the event must be published, all shows scheduled in the future and no ticket admitted.'}</p>}
      {c.unresolvedPayments>0&&<p>{c.unresolvedPayments} non-successful payment attempts remain in history. Delayed callbacks may create additional compensation later.</p>}
      {owner&&(data.requestable||job?.status==='NEEDS_REVIEW')&&(confirm?<section className="layout-confirmation"><h3>{action==='request'?'Cancel this entire event?':'Resume the reviewed cleanup?'}</h3>
        <p>{action==='request'?'This closes every show for new holds, confirmation and admission. Bookings are cancelled in batches and full simulated refunds are queued. This action cannot be undone here.':'This retries unfinished cleanup with a new review generation. Existing cancelled bookings and refund identities are preserved.'}</p>
        <button className="primary-button" onClick={()=>send(action)}>Confirm {action==='request'?'event cancellation':'resume'}</button><button className="secondary-button" onClick={()=>setConfirm(null)}>Keep current state</button>
      </section>:<button className="primary-button" onClick={()=>setConfirm(action)}>{action==='request'?'Review whole-event cancellation':'Resume reviewed cleanup'}</button>)}
      {!owner&&<p>Staff can read progress. An owner confirms cancellation or resumes reviewed work.</p>}
    </>}
  </main>;
}
