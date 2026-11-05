import test from 'node:test';
import assert from 'node:assert/strict';
import {ticketCredential,verifyTicketCredential} from '../apps/api/src/bookings/tickets.js';
import {ticketRequest} from '../apps/web/src/bookings/tickets.js';
const id='90000000-0000-4000-8000-000000000001',secret='ab'.repeat(32),options={bookingId:id,showId:id,seatIds:[id]};
test('versioned admission credentials are stable, domain-bound and reject tampering or wrong keys',()=>{
 const a=ticketCredential(id,secret);assert.equal(a,ticketCredential(id,secret));assert.equal(verifyTicketCredential(a,secret),id);
 assert.equal(verifyTicketCredential(a,'cd'.repeat(32)),null);assert.equal(verifyTicketCredential(a.replace('sl1.','sl2.'),secret),null);
 assert.equal(verifyTicketCredential(a.slice(0,-1)+(a.endsWith('a')?'b':'a'),secret),null);assert.equal(verifyTicketCredential('https://example.invalid/'+a,secret),null);
 assert.throws(()=>ticketCredential(id,'bad'));assert.equal(verifyTicketCredential(a+'.extra',secret),null);
});
test('ticket transport uses empty CSRF writes and validates recovery scope, complete seats and credential state',async()=>{
 let sent;await ticketRequest({...options,issue:true,csrfToken:'a'.repeat(43),fetchImpl:async(path,o)=>{sent=o;assert.equal(path,'/api/bookings/'+id+'/tickets');return Response.json({bookingId:id,issued:true,paymentMode:'simulated'});}});
 assert.equal(sent.body,'{}');assert.equal(sent.credentials,'same-origin');assert.equal(sent.cache,'no-store');assert.equal(sent.headers['X-CSRF-Token'],'a'.repeat(43));
 const ticket={id,seatId:id,section:'Stalls',row:'A',number:1,issuedAt:'2026-11-05T10:00:00Z',status:'ISSUED',credential:ticketCredential(id,secret)};
 const fetchFor=t=>async()=>Response.json({bookingId:id,showId:id,paymentMode:'simulated',tickets:t});
 assert.equal((await ticketRequest({...options,fetchImpl:fetchFor([ticket])})).tickets.length,1);
 for(const t of [{...ticket,status:'VOID'},{...ticket,credential:'bad'},{...ticket,seatId:'90000000-0000-4000-8000-000000000002'}])await assert.rejects(ticketRequest({...options,fetchImpl:fetchFor([t])}));
 await assert.rejects(ticketRequest({...options,fetchImpl:fetchFor([ticket,ticket])}));
 assert.equal((await ticketRequest({...options,fetchImpl:fetchFor([{...ticket,status:'VOID',credential:null}])})).tickets[0].credential,null);
});
