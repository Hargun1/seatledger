import React,{useEffect,useRef,useState} from 'react';
import {useAuth} from '../auth/AuthProvider.jsx';
import {utcWhen} from '../discovery/model.js';
import {RefundStatus} from '../payments/RefundStatus.jsx';
import {cancellationRequest,CancellationError} from './cancellation.js';
import '../payments/checkout.css';

const reasons={CUTOFF_PASSED:'The cancellation cutoff has passed.',ALREADY_USED:'At least one ticket has already been admitted.',
  UNAVAILABLE:'Customer cancellation is unavailable for this show.',REVIEW_REQUIRED:'This booking needs review before cancellation.'};
export function Cancellation({booking,onAttempt,onChanged}) {
  const auth=useAuth(),epoch=useRef(0),controller=useRef(null),writing=useRef(false),readRef=useRef(null);
  const callbacks=useRef({onAttempt,onChanged});callbacks.current={onAttempt,onChanged};
  const [state,setState]=useState({loading:true,data:null,error:null}),[confirm,setConfirm]=useState(false),[uncertain,setUncertain]=useState(false);
  useEffect(()=>{
    const load=async()=>{
      if(writing.current)return;
      const own=++epoch.current;controller.current?.abort();const current=new AbortController();controller.current=current;
      setConfirm(false);setState({loading:true,data:null,error:null});
      try{const data=await cancellationRequest({bookingId:booking.id,signal:current.signal});
        if(own!==epoch.current || current.signal.aborted)return;
        setState({loading:false,data,error:null});
        if(data.status==='CANCELLED'){setUncertain(false);if(booking.status==='CONFIRMED')callbacks.current.onChanged?.();}
      }catch(error){if(own===epoch.current&&!current.signal.aborted)setState({loading:false,data:null,error});}
    };
    readRef.current=load;load();const focus=()=>{if(document.visibilityState==='visible')load();};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{++epoch.current;controller.current?.abort();readRef.current=null;window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[booking.id,booking.status]);
  async function cancel(){
    if(writing.current||!state.data?.eligible||!confirm)return;writing.current=true;
    const own=++epoch.current;controller.current?.abort();const current=new AbortController();controller.current=current;
    setConfirm(false);setState({loading:true,data:null,error:null});callbacks.current.onAttempt?.();
    try{await cancellationRequest({bookingId:booking.id,cancel:true,csrfToken:auth.session.csrfToken,signal:current.signal});
      if(own!==epoch.current||current.signal.aborted)return;
      writing.current=false;setUncertain(false);
      if(callbacks.current.onChanged)callbacks.current.onChanged();else readRef.current?.();
    }catch(error){if(own===epoch.current&&!current.signal.aborted){setUncertain(Boolean(error.uncertain));setState({loading:false,data:null,error});}}
    finally{writing.current=false;}
  }
  const data=state.data;
  return <section className="receipt-cancellation" aria-label="Booking cancellation and refund">
    <h3>Cancellation & refund / simulated</h3>
    {state.loading&&<p role="status">{writing.current?'Recording cancellation.':'Checking cancellation status.'}</p>}
    {uncertain&&<p role="status">The original cancellation response is unconfirmed. Refresh status; any explicit retry still targets this same booking.</p>}
    {state.error&&<p role="alert">{state.error instanceof CancellationError?state.error.message:'Cancellation status could not be checked.'}</p>}
    {data&&(data.status==='CANCELLED'?<><p>This booking is cancelled. Its tickets cannot be admitted. Cancellation and refund completion are separate records.</p>
      {data.paymentId?<RefundStatus key={data.paymentId} payment={{id:data.paymentId,amountMinor:booking.totalMinor,currency:booking.currency}}/>:<p>The refund needs review; no funding payment record was returned.</p>}</>
      :<><p>Current demo policy: full simulated refund for the whole booking before <time dateTime={data.deadline}>{utcWhen(data.deadline)}</time> ({data.policy.cutoffMinutes} minutes before show time), provided no ticket has been admitted.</p>
        {!data.eligible&&<p>{reasons[data.reason]||'Cancellation is unavailable.'}</p>}
        {data.eligible&&(!confirm?<button className="secondary-button" onClick={()=>setConfirm(true)}>Cancel this whole booking</button>
          :<div className="receipt-cancel-confirm"><p>Cancel all saved seats? They will be released for others. A full simulated refund will be queued; completion may take longer.</p>
            <button className="primary-button" onClick={cancel}>Yes, cancel booking</button><button className="quiet-button" onClick={()=>setConfirm(false)}>Keep booking</button></div>)}</>)}
    <button className="text-button" disabled={state.loading} onClick={()=>readRef.current?.()}>Refresh cancellation status</button>
    {[401,403].includes(state.error?.status)&&<button className="secondary-button" onClick={()=>auth.refresh()}>Check session</button>}
  </section>;
}
