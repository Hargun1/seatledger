import test from 'node:test';
import assert from 'node:assert/strict';
import {validEventCancellation,eventCancellationRequest} from '../apps/web/src/organizers/event-cancellation.js';
import {bookingReturnPath} from '../apps/web/src/reservations/model.js';

const id=n=>`b0000000-0000-4000-8000-${String(n).padStart(12,'0')}`,at='2026-11-05T10:00:00.123456Z';
const scope={organizationId:id(1),eventId:id(2)},counts={totalBookings:1,cancelledBookings:0,remainingBookings:1,activeHolds:1,remainingAllocations:2,checkedInSeats:0,missingRefundIntents:0,refundRequests:0,refundsCompleted:0,refundsNeedsReview:0,unresolvedPayments:1};
const value={organization:{id:id(1),name:'Organizer',status:'APPROVED',role:'OWNER'},event:{id:id(2),title:'An evening',status:'PUBLISHED'},asOf:at,counts,requestable:true,job:null,paymentMode:'simulated'};
const requested={...value,event:{...value.event,status:'CANCELLED'},requestable:false,job:{status:'PENDING',generation:0,failedAttempts:0,requestedAt:at,completedAt:null,lastErrorCode:null}};
test('event progress binds scope, lifecycle, exact counts and reviewed job state without confusing cleanup/refunds',()=>{
  assert.equal(validEventCancellation(value,scope),true);assert.equal(validEventCancellation(requested,scope),true);
  for(const patch of [{event:{...value.event,id:id(9)}},{paymentMode:'real'},{counts:{...counts,totalBookings:2}},{counts:{...counts,refundsCompleted:1}}])assert.equal(validEventCancellation({...value,...patch},scope),false);
  for(const patch of [{status:'NEEDS_REVIEW'},{status:'COMPLETED'},{generation:-1},{failedAttempts:9},{requestedAt:'bad'}])assert.equal(validEventCancellation({...requested,job:{...requested.job,...patch}},scope),false);
  const complete={...requested,counts:{...counts,cancelledBookings:1,remainingBookings:0,activeHolds:0,remainingAllocations:0,refundRequests:1,refundsCompleted:0},job:{...requested.job,status:'COMPLETED',completedAt:at}};
  assert.equal(validEventCancellation(complete,scope),true,'Allocation cleanup can finish while money remains queued');
});
test('event request/resume use empty or generation-bound CSRF mutations, read recovery is GET-only and errors stay safe',async()=>{
  let sent;await eventCancellationRequest('read',{...scope,fetchImpl:async(path,o)=>{sent={path,o};return Response.json(value);}});
  assert.equal(sent.o.method,'GET');assert.equal(sent.o.cache,'no-store');assert.equal(sent.o.credentials,'same-origin');assert.equal(sent.o.body,undefined);
  await eventCancellationRequest('request',{...scope,csrfToken:'a'.repeat(43),fetchImpl:async(path,o)=>{sent={path,o};return Response.json(requested);}});
  assert.equal(sent.o.body,'{}');assert.equal(sent.o.headers['X-CSRF-Token'],'a'.repeat(43));
  await eventCancellationRequest('resume',{...scope,expectedGeneration:0,csrfToken:'a'.repeat(43),fetchImpl:async(path,o)=>{sent={path,o};return Response.json({...requested,job:{...requested.job,generation:1}});}});
  assert.ok(sent.path.endsWith('/resume'));assert.deepEqual(JSON.parse(sent.o.body),{expectedGeneration:0});
  await assert.rejects(eventCancellationRequest('request',{...scope,csrfToken:'a'.repeat(43),fetchImpl:async()=>Response.json(value)}),e=>e.uncertain);
  await assert.rejects(eventCancellationRequest('request',{...scope,csrfToken:'a'.repeat(43),fetchImpl:async()=>{throw Error('private');}}),e=>e.uncertain&&!e.message.includes('private'));
  await assert.rejects(eventCancellationRequest('read',{...scope,fetchImpl:async()=>Response.json({error:'private driver error'},{status:500})}),e=>e.status===500&&!e.message.includes('private'));
});
test('event cancellation sign-in return path accepts only exact internal organization/event scope',()=>{
  const path=`/organizers/${id(1)}/events/${id(2)}/cancellation`;
  assert.equal(bookingReturnPath(path),path);
  for(const other of [path+'?next=evil',path+'/resume',path+'/..','//evil.invalid'+path,path.replace(id(2),'bad')])assert.equal(bookingReturnPath(other),null);
});
