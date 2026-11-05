import { canonicalId } from '../payments/model.js';
import { instant } from '../discovery/model.js';

const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
export function validBooking(v,detail=false) {
  if(!v||![v.id,v.reservationId,v.showId].every(canonicalId)||!['CONFIRMED','CANCELLED'].includes(v.status)||v.paymentMode!=='simulated'
    ||!instant(v.createdAt)||!(v.status==='CONFIRMED'?v.cancelledAt===null:instant(v.cancelledAt))
    ||!Number.isSafeInteger(v.totalMinor)||v.totalMinor<0||!Number.isInteger(v.seatCount)||v.seatCount<1||v.seatCount>8||!text(v.currency,3)||!/^[A-Z]{3}$/.test(v.currency))return false;
 const p=v.currentProgramme;if(!p||!canonicalId(p.eventId)||p.current!==true||!text(p.title,200)||!instant(p.startsAt)||!text(p.venue,160)||!text(p.city,120)||!text(p.timezone,80)
   ||(p.eventStatus!==undefined&&!['DRAFT','PUBLISHED','CANCELLED'].includes(p.eventStatus)))return false;
  try{new Intl.DateTimeFormat('en-IN',{timeZone:p.timezone});}catch{return false;}
  return !detail||(Array.isArray(v.items)&&v.items.length===v.seatCount&&v.items.every((s,i)=>s&&canonicalId(s.id)&&s.id>(v.items[i-1]?.id||'')
    &&text(s.section,160)&&text(s.row,32)&&Number.isInteger(s.number)&&s.number>0&&s.currency===v.currency&&Number.isInteger(s.priceMinor)&&s.priceMinor>=0&&s.priceMinor<=2147483647)
    &&v.items.reduce((n,s)=>n+s.priceMinor,0)===v.totalMinor);
}
export class ReceiptError extends Error {
  constructor(status=0){super(status===401||status===403?'Check your session to view your bookings.':status===404?'This booking is not available for your account.':'We could not verify your bookings. Please check again.');this.status=status;}
}
const cursorOk=c=>typeof c==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(c);
export async function bookingRequest({id,cursor,signal,fetchImpl=globalThis.fetch}={}) {
  if((id!==undefined&&!canonicalId(id))||(cursor!==undefined&&(!cursorOk(cursor)||id)))throw new ReceiptError(400);
  let response,data;try{response=await fetchImpl('/api/bookings'+(id?'/'+id:cursor?'?cursor='+cursor:''),{credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});data=await response.json();}catch{throw new ReceiptError();}
  if(!response.ok)throw new ReceiptError(response.status);
  if(response.status!==200)throw new ReceiptError();
  if(id){if(!validBooking(data,true)||data.id!==id)throw new ReceiptError();}
  else if(data?.paymentMode!=='simulated'||!Array.isArray(data.items)||data.items.length>20||!data.items.every((v,i)=>validBooking(v)&&(!i||v.createdAt<data.items[i-1].createdAt||(v.createdAt===data.items[i-1].createdAt&&v.id>data.items[i-1].id)))
    ||!(data.nextCursor===null||(data.items.length===20&&cursorOk(data.nextCursor)&&data.nextCursor!==cursor)))throw new ReceiptError();
  return data;
}
