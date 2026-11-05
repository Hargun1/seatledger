import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { localCallbackUrl,postSimulatedEvent,DeliveryError } from '../apps/api/src/payments/delivery-http.js';
import { runDeliveryBatch } from '../apps/api/src/payments/delivery.js';

test('local callback transport refuses external targets/redirects, bounds acknowledgements and times out a trickling body',async()=>{
  let mode='ok';const seen=[],secret='cd'.repeat(32),body=Buffer.from('{"test":"transport only"}');
  const server=createServer((req,res)=>{
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
      seen.push({body:Buffer.concat(chunks),signature:req.headers['x-seatledger-signature']});res.setHeader('Content-Type','application/json');
      if(mode==='redirect'){res.writeHead(302,{Location:'https://example.com/'});res.end();}
      else if(mode==='big')res.end(' '.repeat(1025));
      else if(mode==='bad')res.writeHead(202).end('{"status":"recorded","paymentMode":"live"}');
      else if(mode==='conflict')res.writeHead(409).end('{}');
      else if(mode==='slow'){res.writeHead(202);const timer=setInterval(()=>res.write(' '),20);res.on('close',()=>clearInterval(timer));}
      else res.writeHead(202).end('{"status":"recorded","paymentMode":"simulated"}');
    });
  }).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/payments/simulated/events`;
  try {
    assert.equal(localCallbackUrl(url).hostname,'127.0.0.1');
    for(const target of ['https://127.0.0.1/api/payments/simulated/events','http://example.com/api/payments/simulated/events',url+'?target=external',url+'#fragment',url.replace('127.0.0.1','user:password@127.0.0.1'),url.replace('/simulated/events','/other')])assert.throws(()=>localCallbackUrl(target),TypeError);
    await assert.rejects(runDeliveryBatch({query(){throw new Error('must not connect');}},{callbackUrl:'https://example.com',secret}),TypeError);
    await postSimulatedEvent(body,{callbackUrl:url,secret});assert.deepEqual(seen[0].body,body);assert.match(seen[0].signature,/^t=\d+,v1=[a-f0-9]{64}$/);
    for(const [next,code]of [['redirect','CALLBACK_REJECTED'],['big','CALLBACK_UNACKNOWLEDGED'],['bad','CALLBACK_UNACKNOWLEDGED'],['conflict','CALLBACK_REJECTED'],['slow','DELIVERY_TIMEOUT']]){
      mode=next;await assert.rejects(postSimulatedEvent(body,{callbackUrl:url,secret,timeoutMs:150}),e=>e instanceof DeliveryError&&e.code===code&&(next!=='conflict'||!e.retryable));
    }assert.equal(seen.length,6); // Redirect produced no second request.
  } finally {await new Promise(resolve=>server.close(resolve));}
});
