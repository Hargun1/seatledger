import { request } from 'node:http';
import { signSimulatedDelivery } from './events.js';

export class DeliveryError extends Error {
  constructor(code,retryable=true){super('The local simulator callback was not acknowledged.');this.code=code;this.retryable=retryable;}
}
export function localCallbackUrl(value) {
  let url;try{url=new URL(value);}catch{throw new TypeError('Invalid local simulator callback URL');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/api/payments/simulated/events')
    throw new TypeError('The simulator callback must use its loopback HTTP endpoint');
  return url;
}
export async function postSimulatedEvent(body,{callbackUrl,secret,timeoutMs=2000}={}) {
  const url=localCallbackUrl(callbackUrl);
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)throw new TypeError('Invalid delivery HTTP budget');
  const signature=signSimulatedDelivery(body,{secret});
  return new Promise((resolve,reject)=>{
    let finished=false,timer;
    const done=error=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve();};
    const req=request(url,{method:'POST',agent:false,maxHeaderSize:8192,headers:{'Content-Type':'application/json','Content-Length':body.length,'X-SeatLedger-Signature':signature}},res=>{
      let length=0;const chunks=[];
      res.on('data',chunk=>{length+=chunk.length;if(length>1024){done(new DeliveryError('CALLBACK_UNACKNOWLEDGED'));req.destroy();}else chunks.push(chunk);});
      res.on('error',()=>done(new DeliveryError('DELIVERY_TRANSPORT')));
      res.on('end',()=>{
        if(res.statusCode!==202)return done(new DeliveryError('CALLBACK_REJECTED',![400,409,413,415].includes(res.statusCode)));
        let receipt;try{receipt=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return done(new DeliveryError('CALLBACK_UNACKNOWLEDGED'));}
        if(!receipt || Array.isArray(receipt) || Object.keys(receipt).length!==2 || receipt.status!=='recorded'||receipt.paymentMode!=='simulated')return done(new DeliveryError('CALLBACK_UNACKNOWLEDGED'));
        done();
      });
    });
    req.on('error',error=>done(error instanceof DeliveryError?error:new DeliveryError('DELIVERY_TRANSPORT')));
    timer=setTimeout(()=>{done(new DeliveryError('DELIVERY_TIMEOUT'));req.destroy();},timeoutMs);
    req.end(body);
  });
}
