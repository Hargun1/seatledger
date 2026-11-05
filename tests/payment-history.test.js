import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHistoryCursor, encodeHistoryCursor } from '../apps/api/src/reliability/history-cursor.js';
import { validPaymentHistoryItem, readAccountPayments, paymentHistoryCheckoutPath } from '../apps/web/src/payments/history.js';
import { bookingReturnPath } from '../apps/web/src/reservations/model.js';

const id = n => `80000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const payment = patch => ({ id:id(1), reservationId:id(2), showId:id(3), amountMinor:75000, currency:'INR', status:'CREATED',
  resolution:'UNRESOLVED', bookingId:null, createdAt:'2026-11-05T10:00:00.123456Z', paymentMode:'simulated',
  currentProgramme:{eventId:id(4),title:'A local evening',venue:'Saved room',city:'Bengaluru',startsAt:'2030-01-01T10:00:00.000000Z',timezone:'Asia/Kolkata',current:true}, ...patch });

test('account payment model and local recovery path reject forged outcome, scope and programme', () => {
  const row = payment(); assert.equal(validPaymentHistoryItem(row),true);
  const path = `/events/${id(4)}/shows/${id(3)}/checkout/${id(2)}`;
  assert.equal(paymentHistoryCheckoutPath(row),path); assert.equal(bookingReturnPath(path),path);
  assert.equal(bookingReturnPath('/account/payments'),'/account/payments');
  for (const unsafe of ['/account/payments?next=evil','/account/payments/extra','//evil.invalid/account/payments','/account/payments/..']) assert.equal(bookingReturnPath(unsafe),null);
  for (const patch of [{amountMinor:-1},{amountMinor:Number.MAX_SAFE_INTEGER+1},{showId:'bad'},{reservationId:'bad'},
    {status:'SUCCEEDED'},{resolution:'BOOKED'},{bookingId:id(5)},{createdAt:'2026-11-05T10:00:00Z'},{paymentMode:'real'},
    {currentProgramme:{...row.currentProgramme,eventId:'https://evil.invalid'}},{currentProgramme:{...row.currentProgramme,timezone:'Unknown/Zone'}}]) {
    assert.equal(validPaymentHistoryItem(payment(patch)),false); assert.equal(paymentHistoryCheckoutPath(payment(patch)),null);
  }
  assert.equal(validPaymentHistoryItem(payment({status:'SUCCEEDED',resolution:'REFUND_REQUIRED'})),true);
  assert.equal(validPaymentHistoryItem(payment({status:'SUCCEEDED',resolution:'BOOKED',bookingId:id(6)})),true);
});

test('history cursor keeps exact microseconds and rejects malformed calendar, extra keys and SQL-shaped inputs', () => {
  const row = payment(), encoded = encodeHistoryCursor(row);
  assert.deepEqual(decodeHistoryCursor(encoded),{at:row.createdAt,id:row.id});
  assert.equal(decodeHistoryCursor(undefined),null);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const value of ['', 'bad', "' OR TRUE --", encode(null), encode({at:row.createdAt,id:row.id,owner:id(7)}),
    ...['0000-01-01T10:00:00.123456Z','2026-02-30T10:00:00.123456Z','2026-11-05T25:00:00.123456Z','2026-11-05T10:00:00.123Z'].map(at=>encode({at,id:row.id}))])
    assert.throws(()=>decodeHistoryCursor(value),error=>error.status===400);
});

test('history transport only reads bounded, unique ordered pages and hides arbitrary server errors', async () => {
  const rows = Array.from({length:20},(_,n)=>payment({id:id(n+10)})), cursor = encodeHistoryCursor(rows.at(-1));
  let sent; const response = {items:rows,nextCursor:cursor,paymentMode:'simulated'};
  const actual = await readAccountPayments({fetchImpl:async(path,options)=>{sent={path,options};return Response.json(response);}});
  assert.deepEqual(actual,response); assert.equal(sent.path,'/api/payments');
  assert.equal(sent.options.method,'GET'); assert.equal(sent.options.credentials,'same-origin'); assert.equal(sent.options.cache,'no-store');
  assert.equal(sent.options.body,undefined); assert.equal(sent.options.headers,undefined);
  await readAccountPayments({cursor,fetchImpl:async(path)=>{assert.equal(path,'/api/payments?cursor='+cursor);return Response.json({items:[],nextCursor:null,paymentMode:'simulated'});}});
  const invalid = [{...response,items:[...rows].reverse()},{...response,items:[rows[0],rows[0]],nextCursor:null},
    {...response,items:[rows[0]],nextCursor:cursor},{...response,items:[...rows,rows[0]]},
    {...response,items:[payment({createdAt:'2026-11-05T10:00:00.123455Z'}),payment({id:id(2)})],nextCursor:null}];
  for(const body of invalid) await assert.rejects(readAccountPayments({fetchImpl:async()=>Response.json(body)}),error=>error.code==='INVALID_RESPONSE');
  await assert.rejects(readAccountPayments({cursor,fetchImpl:async()=>Response.json(response)}),error=>error.code==='INVALID_RESPONSE');
  await assert.rejects(readAccountPayments({fetchImpl:async()=>Response.json({error:'secret driver details'},{status:500})}),error=>!error.message.includes('secret')&&error.status===500);
  await assert.rejects(readAccountPayments({fetchImpl:async()=>Response.json({error:'AUTH_REQUIRED'},{status:401})}),error=>error.status===401);
});
