import {canonicalId} from '../payments/model.js';
import {instant} from '../discovery/model.js';

const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const count=v=>Number.isSafeInteger(v)&&v>=0;
const stamp=v=>instant(v)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v);
export function validEventCancellation(v,{organizationId,eventId}){
  if(!v||v.paymentMode!=='simulated'||v.organization?.id!==organizationId||v.organization.status!=='APPROVED'
    ||!['OWNER','STAFF'].includes(v.organization.role)||!text(v.organization.name,160)||v.event?.id!==eventId||!text(v.event.title,200)
    ||!['DRAFT','PUBLISHED','CANCELLED'].includes(v.event.status)||!stamp(v.asOf)||typeof v.requestable!=='boolean')return false;
  const c=v.counts;if(!c||!['totalBookings','cancelledBookings','remainingBookings','activeHolds','remainingAllocations','checkedInSeats','missingRefundIntents','refundRequests','refundsCompleted','refundsNeedsReview','unresolvedPayments'].every(k=>count(c[k]))
    ||c.totalBookings!==c.cancelledBookings+c.remainingBookings||c.refundsCompleted>c.refundRequests||c.refundsNeedsReview>c.refundRequests)return false;
  if(v.requestable&&(v.event.status!=='PUBLISHED'||v.job!==null||c.checkedInSeats!==0))return false;
  if(v.job===null)return true;
  const j=v.job;return !!j&&v.event.status==='CANCELLED'&&v.requestable===false&&['PENDING','PROCESSING','NEEDS_REVIEW','COMPLETED'].includes(j.status)
    &&count(j.generation)&&j.generation<=2147483647&&count(j.failedAttempts)&&j.failedAttempts<=8&&stamp(j.requestedAt)
    &&(j.status==='COMPLETED'?stamp(j.completedAt)&&j.completedAt>=j.requestedAt:j.completedAt===null)
    &&[null,'EVENT_CANCELLATION_RETRY','EVENT_CANCELLATION_REVIEW'].includes(j.lastErrorCode)
    &&(j.status!=='NEEDS_REVIEW'||j.lastErrorCode!==null);
}
export class EventCancellationError extends Error{
  constructor(status=0,uncertain=false){super(status===401||status===403?'Check your session and owner access.':status===404?'This event is unavailable for your account.':status===409?'This event cannot accept that cancellation action. Refresh its current progress.':'We could not confirm event cancellation progress. Check again.');this.status=status;this.uncertain=uncertain;}
}
export async function eventCancellationRequest(action,{organizationId,eventId,expectedGeneration,csrfToken,signal,fetchImpl=globalThis.fetch}={}){
  const write=action!=='read';
  if(!['read','request','resume'].includes(action)||![organizationId,eventId].every(canonicalId)
    ||(action==='resume'&&(!count(expectedGeneration)||expectedGeneration>2147483646)))throw new EventCancellationError(400);
  if(write&&(typeof csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(csrfToken)))throw new EventCancellationError(401);
  let response,data;try{
    response=await fetchImpl(`/api/organizers/${organizationId}/events/${eventId}/cancellation`+(action==='resume'?'/resume':''),{
      method:write?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
      ...(write?{headers:{'Content-Type':'application/json','X-SeatLedger-Client':'web','X-CSRF-Token':csrfToken},body:JSON.stringify(action==='resume'?{expectedGeneration}:{})}:{})});
    data=await response.json();
  }catch{throw new EventCancellationError(0,write);}
  if(!response.ok||response.status!==200)throw new EventCancellationError(response.status,write);
  if(!validEventCancellation(data,{organizationId,eventId})||(write&&(!data.job||data.event.status!=='CANCELLED')))throw new EventCancellationError(0,write);
  return data;
}
