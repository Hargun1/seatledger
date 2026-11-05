import {canonicalId} from '../payments/model.js';
import {instant} from '../discovery/model.js';

const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const count=v=>Number.isSafeInteger(v)&&v>=0;
const stamp=v=>instant(v)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v);
const cursorOk=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(v);
const amount=v=>typeof v==='string'&&/^(0|[1-9]\d{0,63})$/.test(v);
function validScope(v,{organizationId,eventId,showId}) {
  return v?.paymentMode==='simulated'&&v.organization?.id===organizationId&&v.organization.status==='APPROVED'
    &&['OWNER','STAFF'].includes(v.organization.role)&&text(v.organization.name,160)
    &&v.event?.id===eventId&&text(v.event.title,200)&&['DRAFT','PUBLISHED','CANCELLED'].includes(v.event.status)
    &&v.show?.id===showId&&['SCHEDULED','CANCELLED','COMPLETED'].includes(v.show.status)&&stamp(v.show.startsAt)&&stamp(v.asOf);
}
export function validOperationsSummary(v,scope) {
  if(!validScope(v,scope))return false;
  const i=v.inventory,b=v.bookings,a=v.attendance;
  if(!i||!['total','available','held','booked','expiredHolds'].every(k=>count(i[k]))||i.available+i.held+i.booked!==i.total||i.expiredHolds>i.held
    ||!b||!['confirmed','cancelled'].every(k=>count(b[k]))||!a||!['confirmedSeats','checkedInSeats'].every(k=>count(a[k])))return false;
  return v.organization.role==='STAFF'?v.financials===null:Array.isArray(v.financials)&&v.financials.length<=20&&v.financials.every((m,n)=>m&&/^[A-Z]{3}$/.test(m.currency)
    &&(!n||m.currency>v.financials[n-1].currency)&&['capturedMinor','confirmedRefundMinor','unconfirmedRefundMinor'].every(k=>amount(m[k]))&&count(m.refundReviewCount));
}
export function validOperationsBookings(v,scope,cursor) {
  if(!validScope(v,scope)||!Array.isArray(v.items)||v.items.length>20)return false;
  const owner=v.organization.role==='OWNER';
  return v.items.every((b,n)=>b&&canonicalId(b.id)&&['CONFIRMED','CANCELLED'].includes(b.status)&&stamp(b.createdAt)&&text(b.customerName,120)
    &&(owner?count(b.totalMinor)&&typeof b.currency==='string'&&/^[A-Z]{3}$/.test(b.currency):b.totalMinor===null&&b.currency===null)
    &&Array.isArray(b.seats)&&b.seats.length>=1&&b.seats.length<=8&&b.seats.every((s,k)=>s&&canonicalId(s.id)&&s.id>(b.seats[k-1]?.id||'')&&text(s.section,160)&&text(s.row,32)&&Number.isInteger(s.number)&&s.number>0)
    &&count(b.checkedInSeats)&&b.checkedInSeats<=b.seats.length&&(!n||b.createdAt<v.items[n-1].createdAt||(b.createdAt===v.items[n-1].createdAt&&b.id>v.items[n-1].id)))
    &&new Set(v.items.map(b=>b.id)).size===v.items.length
    &&(v.nextCursor===null||(v.items.length===20&&cursorOk(v.nextCursor)&&v.nextCursor!==cursor));
}
export function reportMinor(value,currency) {
  return amount(value)&&typeof currency==='string'&&/^[A-Z]{3}$/.test(currency)?`${BigInt(value).toLocaleString('en-IN')} ${currency} minor units`:'Unavailable';
}
export class OperationsError extends Error {
  constructor(status=0){super(status===401||status===403?'Check your session and approved organizer access.':status===404?'This show report is unavailable for your account.':'We could not verify this report. Refresh and try again.');this.status=status;}
}
export async function operationsRequest(action,{organizationId,eventId,showId,cursor,role,signal,fetchImpl=globalThis.fetch}={}) {
  if(!['summary','bookings','export'].includes(action)||![organizationId,eventId,showId].every(canonicalId)
    ||(cursor!==undefined&&(!cursorOk(cursor)||action==='summary'))||(role!==undefined&&!['OWNER','STAFF'].includes(role)))throw new OperationsError(400);
  let response,data;
  try{
    response=await fetchImpl(`/api/organizers/${organizationId}/events/${eventId}/shows/${showId}/operations`
      +(action==='summary'?'':'/'+action)+(cursor?'?cursor='+cursor:''),{method:'GET',credentials:'same-origin',cache:'no-store',
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    if(!response.ok||response.status!==200)throw new OperationsError(response.status);
    data=action==='export'?await response.text():await response.json();
  }catch(error){if(error instanceof OperationsError)throw error;throw new OperationsError();}
  const scope={organizationId,eventId,showId};
  if(action==='export'){
    const exportedRole=response.headers.get('X-Report-Role'),asOf=response.headers.get('X-As-Of'),rawCount=response.headers.get('X-Export-Row-Count'),next=response.headers.get('X-Next-Cursor')||null;
    if(!/^text\/csv(?:;|$)/i.test(response.headers.get('Content-Type')||'')||response.headers.get('X-Show-Id')!==showId||!['OWNER','STAFF'].includes(exportedRole)
      ||(role&&role!==exportedRole)||!stamp(asOf)||!rawCount||!/^(?:[0-9]|1[0-9]|20)$/.test(rawCount)
      ||(next&&(!cursorOk(next)||Number(rawCount)!==20||next===cursor))||data.length>200000
      ||!data.replace(/^\uFEFF/,'').startsWith('"snapshot_utc","booking_id","booking_status","created_at_utc","current_customer_name",'))throw new OperationsError();
    return {csv:data,asOf,rowCount:Number(rawCount),nextCursor:next,role:exportedRole};
  }
  if(!(action==='summary'?validOperationsSummary(data,scope):validOperationsBookings(data,scope,cursor)))throw new OperationsError();
  return data;
}
