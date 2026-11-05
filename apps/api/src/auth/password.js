import { scrypt as derive, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../http-error.js';

const scrypt=promisify(derive);
const parameters={N:131072,r:8,p:1,maxmem:192*1024*1024};
const pattern=/^sl-scrypt-v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const dummy=`sl-scrypt-v1$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
let running=0;
async function key(password,salt) {
  if(running>=2) throw new HttpError(503,'AUTH_BUSY');
  running++;
  try { return await scrypt(password,Buffer.from(salt,'hex'),64,parameters); }
  finally { running--; }
}
export async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex');
  const value=await key(password,salt);
  return `sl-scrypt-v1$131072$8$1$${salt}$${value.toString('hex')}`;
}
export async function verifyPassword(password,record) {
  const valid=typeof record==='string' && pattern.test(record);
  const match=pattern.exec(valid?record:dummy);
  const actual=await key(password,match[1]);
  return timingSafeEqual(actual,Buffer.from(match[2],'hex')) && valid;
}
