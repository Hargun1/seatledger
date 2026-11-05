import {canonicalId} from '../payments/model.js';
import {instant} from '../discovery/model.js';
import {ReceiptError} from './client.js';
export async function ticketRequest({bookingId,showId,seatIds,issue=false,csrfToken,signal,fetchImpl=globalThis.fetch}){
 if(!canonicalId(bookingId)||!canonicalId(showId)||!Array.isArray(seatIds)||seatIds.length<1||seatIds.length>8||!seatIds.every(canonicalId)||new Set(seatIds).size!==seatIds.length)throw new ReceiptError(400);
 if(issue&&(typeof csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(csrfToken)))throw new ReceiptError(401);
 let response,data;try{response=await fetchImpl('/api/bookings/'+bookingId+'/tickets',{method:issue?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000),
  ...(issue?{headers:{'Content-Type':'application/json','X-SeatLedger-Client':'web','X-CSRF-Token':csrfToken},body:'{}'}:{})});data=await response.json();}catch{throw new ReceiptError();}
 if(response.status!==200)throw new ReceiptError(response.status);
 if(data?.bookingId!==bookingId||data.paymentMode!=='simulated')throw new ReceiptError();
 if(issue){if(data.issued!==true)throw new ReceiptError();return data;}
 if(data.showId!==showId||!Array.isArray(data.tickets)||!(data.tickets.length===0||data.tickets.length===seatIds.length))throw new ReceiptError();
 const seen=new Set();for(const t of data.tickets){
  if(!t||!canonicalId(t.id)||!seatIds.includes(t.seatId)||seen.has(t.seatId)||!instant(t.issuedAt)||!['ISSUED','USED','VOID','EXPIRED'].includes(t.status)
   ||typeof t.section!=='string'||t.section.length<1||t.section.length>160||typeof t.row!=='string'||t.row.length<1||t.row.length>32||!Number.isInteger(t.number)||t.number<1
   ||(t.status==='ISSUED'?typeof t.credential!=='string'||!new RegExp('^sl1\\.'+t.id+'\\.[A-Za-z0-9_-]{43}$').test(t.credential):t.credential!==null))throw new ReceiptError();seen.add(t.seatId);
 }return data;
}
