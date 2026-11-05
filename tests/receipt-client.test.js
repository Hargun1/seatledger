import test from 'node:test';
import assert from 'node:assert/strict';
import { validBooking,bookingRequest } from '../apps/web/src/bookings/client.js';
import { decodeBookingCursor } from '../apps/api/src/bookings/routes.js';
import { bookingReturnPath } from '../apps/web/src/reservations/model.js';
const id='80000000-0000-4000-8000-000000000001';
const booking={id,reservationId:id,showId:id,status:'CONFIRMED',cancelledAt:null,createdAt:'2026-11-04T10:00:00.123456Z',totalMinor:100,currency:'INR',seatCount:1,paymentMode:'simulated',currentProgramme:{eventId:id,title:'Evening',startsAt:'2030-01-01T10:00:00Z',venue:'Room',city:'City',timezone:'Asia/Kolkata',current:true},items:[{id,section:'Saved',row:'A',number:1,priceMinor:100,currency:'INR'}]};
test('receipt model, cursor and internal recovery paths validate saved facts',()=>{
 assert.equal(validBooking(booking,true),true);for(const change of [{totalMinor:99},{items:[]},{status:'PAID'},{paymentMode:'real'},{cancelledAt:'invalid'}])assert.equal(validBooking({...booking,...change},true),false);
 const raw={at:booking.createdAt,id};assert.deepEqual(decodeBookingCursor(Buffer.from(JSON.stringify(raw)).toString('base64url')),raw);
 for(const raw of ['bad',...['2026-02-30T10:00:00.123456Z','0000-01-01T10:00:00.123456Z'].map(at=>Buffer.from(JSON.stringify({at,id})).toString('base64url'))])assert.throws(()=>decodeBookingCursor(raw),e=>e.status===400);
 assert.equal(bookingReturnPath('/account/bookings/'+id),'/account/bookings/'+id);assert.equal(bookingReturnPath('/account/bookings'),'/account/bookings');assert.equal(bookingReturnPath('/account/bookings/'+id+'?next=evil'),null);
});
test('receipt transport accepts owned evidence and hides arbitrary errors or mismatched receipts',async()=>{
 let options;assert.deepEqual(await bookingRequest({id,fetchImpl:async(path,o)=>{options=o;assert.equal(path,'/api/bookings/'+id);return Response.json(booking);}}),booking);
 assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
 await assert.rejects(bookingRequest({id,fetchImpl:async()=>Response.json({...booking,totalMinor:1})}));
 await assert.rejects(bookingRequest({id,fetchImpl:async()=>Response.json({error:'private database text'},{status:500})}),e=>!e.message.includes('private'));
});
