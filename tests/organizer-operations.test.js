import test from 'node:test';
import assert from 'node:assert/strict';
import {csvCell,operationsCsv} from '../apps/api/src/organizers/operations.js';
import {validOperationsSummary,validOperationsBookings,operationsRequest,reportMinor} from '../apps/web/src/organizers/operations.js';
import {bookingReturnPath} from '../apps/web/src/reservations/model.js';

const id=n=>`a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`,at='2026-11-05T10:00:00.123456Z';
const scope={organizationId:id(1),eventId:id(2),showId:id(3)};
const base={organization:{id:id(1),name:'Local organizer',status:'APPROVED',role:'OWNER'},event:{id:id(2),title:'An evening',status:'PUBLISHED'},show:{id:id(3),status:'SCHEDULED',startsAt:at},asOf:at,paymentMode:'simulated'};
const booking=(patch={})=>({id:id(4),status:'CONFIRMED',createdAt:at,customerName:'=SUM(1,2)',totalMinor:75000,currency:'INR',checkedInSeats:0,seats:[{id:id(5),section:'Stalls',row:'A',number:1}],...patch});
const summary={...base,inventory:{total:2,available:1,held:1,booked:0,expiredHolds:1},bookings:{confirmed:1,cancelled:1},attendance:{confirmedSeats:1,checkedInSeats:0},financials:[{currency:'INR',capturedMinor:'9007199254740993',confirmedRefundMinor:'0',unconfirmedRefundMinor:'75000',refundReviewCount:1}]};

test('organizer report binds scope, role, stock arithmetic, unique paging and exact monetary strings',()=>{
  assert.equal(validOperationsSummary(summary,scope),true);assert.equal(validOperationsSummary({...summary,show:{...base.show,id:id(9)}},scope),false);
  assert.equal(validOperationsSummary({...summary,inventory:{...summary.inventory,total:3}},scope),false);
  const staff={...base,organization:{...base.organization,role:'STAFF'}};
  assert.equal(validOperationsSummary({...summary,...staff,financials:null},scope),true);
  assert.equal(validOperationsSummary({...summary,...staff},scope),false);
  const page={...base,items:[booking()],nextCursor:null};assert.equal(validOperationsBookings(page,scope),true);
  assert.equal(validOperationsBookings({...page,...staff},scope),false);
  assert.equal(validOperationsBookings({...page,...staff,items:[booking({totalMinor:null,currency:null})]},scope),true);
  for(const patch of [{checkedInSeats:2},{createdAt:'bad'},{totalMinor:Number.MAX_SAFE_INTEGER+1},{seats:[]}])assert.equal(validOperationsBookings({...page,items:[booking(patch)]},scope),false);
  assert.equal(validOperationsBookings({...page,items:[booking(),booking()]},scope),false);
  assert.equal(reportMinor('9007199254740993','INR').replaceAll(',',''),'9007199254740993 INR minor units');
  assert.equal(reportMinor('-1','INR'),'Unavailable');
  const route=`/organizers/${id(1)}/events/${id(2)}/shows/${id(3)}/operations`;
  assert.equal(bookingReturnPath(route),route);for(const value of [route+'?next=evil',route+'/extra','//evil.invalid'+route])assert.equal(bookingReturnPath(value),null);
});
test('CSV quotes delimiters/quotes, removes control rows and prefixes all untrusted text; staff export has no money columns',()=>{
  assert.equal(csvCell('=SUM(1,2)'),`"'=SUM(1,2)"`);
  for(const text of ['+1','-1','@cmd',' \t=1'])assert.ok(csvCell(text).startsWith('"\''));
  assert.equal(csvCell('a"b\r\nc'),`"'a""b  c"`);assert.equal(csvCell(75000),'"75000"');
  const report={...base,items:[booking()],nextCursor:null},csv=operationsCsv(report);
  assert.ok(csv.startsWith('\uFEFF"snapshot_utc"'));assert.ok(csv.includes(`"'=SUM(1,2)"`));assert.ok(csv.includes('"total_minor","currency"'));
  const staff=operationsCsv({...report,organization:{...base.organization,role:'STAFF'},items:[booking({totalMinor:null,currency:null})]});
  assert.ok(!staff.includes('total_minor'));assert.ok(!staff.includes('75000'));assert.ok(staff.endsWith('\r\n'));
});
test('operations transport accepts only same-scope GET reports and bounded scoped CSV responses',async()=>{
  let sent;assert.deepEqual(await operationsRequest('summary',{...scope,fetchImpl:async(path,o)=>{sent={path,o};return Response.json(summary);}}),summary);
  assert.equal(sent.o.method,'GET');assert.equal(sent.o.cache,'no-store');assert.equal(sent.o.credentials,'same-origin');assert.equal(sent.o.body,undefined);
  const report={...base,items:[booking()],nextCursor:null},csv=operationsCsv(report);
  const headers={'Content-Type':'text/csv; charset=utf-8','X-Show-Id':id(3),'X-Report-Role':'OWNER','X-As-Of':at,'X-Export-Row-Count':'1','X-Next-Cursor':''};
  const result=await operationsRequest('export',{...scope,role:'OWNER',fetchImpl:async()=>new Response(csv,{headers})});assert.equal(result.rowCount,1);
  for(const patch of [{'X-Show-Id':id(9)},{'X-Report-Role':'STAFF'},{'X-Export-Row-Count':'21'},{'Content-Type':'text/html'}])
    await assert.rejects(operationsRequest('export',{...scope,role:'OWNER',fetchImpl:async()=>new Response(csv,{headers:{...headers,...patch}})}));
  await assert.rejects(operationsRequest('summary',{...scope,fetchImpl:async()=>Response.json({...summary,paymentMode:'real'})}));
  await assert.rejects(operationsRequest('summary',{...scope,fetchImpl:async()=>Response.json({error:'private SQL secret'},{status:500})}),e=>e.status===500&&!e.message.includes('secret'));
});
