import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../apps/api/src/config.js';
import {cancellationPolicy} from '../apps/api/src/bookings/cancellation.js';
import {validCancellationPolicy,validCancellation,readBookingPolicy,cancellationRequest} from '../apps/web/src/bookings/cancellation.js';

const id='90000000-0000-4000-8000-000000000001',pay='90000000-0000-4000-8000-000000000002',refund='90000000-0000-4000-8000-000000000003';
const policy=cancellationPolicy({});
const value=(patch={})=>({bookingId:id,status:'CONFIRMED',eligible:true,reason:'ELIGIBLE',cancelledAt:null,
  paymentId:pay,refundId:null,deadline:'2030-01-01T17:00:00.123456Z',policy,paymentMode:'simulated',...patch});
test('cancellation config is bounded, simulated and has a visible full-refund default',()=>{
  assert.equal(policy.cutoffMinutes,60);assert.equal(Object.isFrozen(policy),true);assert.equal(validCancellationPolicy(policy),true);
  const settings={DATABASE_URL:'postgresql://localhost/seatledger',AUTH_SECRET:'ab'.repeat(32)};
  for(const minutes of [0,60,10080])assert.equal(readConfig({...settings,CUSTOMER_CANCELLATION_CUTOFF_MINUTES:String(minutes)}).CUSTOMER_CANCELLATION_CUTOFF_MINUTES,minutes);
  for(const minutes of [-1,1.5,10081,'bad'])assert.throws(()=>readConfig({...settings,CUSTOMER_CANCELLATION_CUTOFF_MINUTES:String(minutes)}));
  for(const patch of [{cutoffMinutes:-1},{refund:'PARTIAL'},{paymentMode:'real'},{version:'other'}])assert.equal(validCancellationPolicy({...policy,...patch}),false);
});
test('cancellation validation distinguishes natural replay, ineligible state and forged cancellation',()=>{
  assert.equal(validCancellation(value(),id),true);
  for(const reason of ['CUTOFF_PASSED','ALREADY_USED','UNAVAILABLE','REVIEW_REQUIRED'])assert.equal(validCancellation(value({reason,eligible:false}),id),true);
  const cancelled=value({status:'CANCELLED',eligible:false,reason:'ALREADY_CANCELLED',cancelledAt:'2029-01-01T10:00:00.000000Z',refundId:refund});
  assert.equal(validCancellation(cancelled,id),true);
  for(const patch of [{eligible:true},{cancelledAt:null},{reason:'ELIGIBLE'},{bookingId:pay},{paymentMode:'real'}])assert.equal(validCancellation({...cancelled,...patch},id),false);
  for(const patch of [{paymentId:null},{refundId:refund},{deadline:'bad'},{reason:'ALREADY_CANCELLED'}])assert.equal(validCancellation(value(patch),id),false);
});
test('cancellation transport sends fixed empty CSRF mutation and rejects uncertain or mismatched replies without leaking errors',async()=>{
  let sent;assert.deepEqual(await readBookingPolicy({fetchImpl:async(path,o)=>{sent={path,o};return Response.json(policy);}}),policy);
  assert.equal(sent.path,'/api/booking-policy');assert.equal(sent.o.method,'GET');assert.equal(sent.o.cache,'no-store');
  const cancelled=value({status:'CANCELLED',eligible:false,reason:'ALREADY_CANCELLED',cancelledAt:'2029-01-01T10:00:00.000000Z',refundId:refund});
  await cancellationRequest({bookingId:id,cancel:true,csrfToken:'a'.repeat(43),fetchImpl:async(path,o)=>{sent={path,o};return Response.json(cancelled);}});
  assert.equal(sent.path,`/api/bookings/${id}/cancellation`);assert.equal(sent.o.method,'POST');assert.equal(sent.o.body,'{}');
  assert.equal(sent.o.headers['X-CSRF-Token'],'a'.repeat(43));assert.equal(sent.o.credentials,'same-origin');
  await assert.rejects(cancellationRequest({bookingId:id,cancel:true,csrfToken:'a'.repeat(43),fetchImpl:async()=>Response.json(value())}),e=>e.uncertain);
  await assert.rejects(cancellationRequest({bookingId:id,cancel:true,csrfToken:'a'.repeat(43),fetchImpl:async()=>{throw Error('private secret');}}),e=>e.uncertain&&!e.message.includes('secret'));
  await assert.rejects(cancellationRequest({bookingId:id,fetchImpl:async()=>Response.json({error:'private driver details'},{status:500})}),e=>e.status===500&&!e.message.includes('private'));
  await assert.rejects(readBookingPolicy({fetchImpl:async()=>Response.json({...policy,paymentMode:'real'})}));
});
