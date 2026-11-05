import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../http-error.js';

export const SESSION_SECONDS=7*24*60*60;
export const digest=value=>createHash('sha256').update(value).digest();
export const newToken=()=>randomBytes(32).toString('base64url');
export const csrfFor=(raw,secret)=>createHmac('sha256',Buffer.from(secret,'hex')).update('seatledger-csrf-v1:').update(raw).digest('base64url');
export const cookieName=config=>config.NODE_ENV==='production'?'__Host-seatledger_session':'seatledger_session';
export const cookieOptions=config=>({httpOnly:true,secure:config.NODE_ENV==='production',sameSite:'lax',path:'/'});
export function sessionCookie(req,config) {
  const name=cookieName(config);
  const matches=(req.headers.cookie??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(`${name}=`));
  if(matches.length!==1) return null;
  const raw=matches[0].slice(name.length+1);
  return /^[A-Za-z0-9_-]{43}$/.test(raw)?raw:null;
}
export function browserMutation(config) {
  return (req,res,next)=>{
    if(req.get('origin')!==config.PUBLIC_ORIGIN || req.get('x-seatledger-client')!=='web' || req.get('sec-fetch-site')==='cross-site') return next(new HttpError(403,'ORIGIN_REJECTED'));
    if(!req.is('application/json')) return next(new HttpError(415,'JSON_REQUIRED'));
    next();
  };
}
export function verifyCsrf(req,session) {
  const token=req.get('x-csrf-token');
  if(typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !timingSafeEqual(digest(token),session.csrfHash)) throw new HttpError(403,'CSRF_REJECTED');
}
