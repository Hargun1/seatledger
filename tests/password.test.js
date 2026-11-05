import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../apps/api/src/auth/password.js';
import { readConfig, readDatabaseConfig } from '../apps/api/src/config.js';

test('salted scrypt hashes verify exact passwords without trimming',async()=>{
  const password='A long test passphrase with spaces  ';
  const a=await hashPassword(password), b=await hashPassword(password);
  assert.notEqual(a,b); assert.equal(a.includes(password),false);
  assert.equal(await verifyPassword(password,a),true);
  assert.equal(await verifyPassword(password.trim(),a),false);
});
test('missing and malformed hashes fail without accepting attacker-controlled cost parameters',async()=>{
  assert.equal(await verifyPassword('Example test passphrase',null),false);
  assert.equal(await verifyPassword('Example test passphrase','sl-scrypt-v1$999999999$8$1$bad$bad'),false);
});
test('password work rejects excess concurrent jobs instead of building an unbounded queue',async()=>{
  const jobs=[hashPassword('First valid test passphrase'),hashPassword('Second valid test passphrase')];
  try {await assert.rejects(hashPassword('Third valid test passphrase'),e=>e.status===503 && e.code==='AUTH_BUSY');}
  finally {await Promise.all(jobs);}
});
test('server configuration requires a private auth secret and HTTPS origin in production',()=>{
  const database={DATABASE_URL:'postgresql://localhost/seatledger'};
  assert.throws(()=>readConfig(database),/Invalid configuration/);
  assert.equal(readDatabaseConfig(database).DATABASE_URL,database.DATABASE_URL);
  assert.throws(()=>readConfig({...database,AUTH_SECRET:'ab'.repeat(32),NODE_ENV:'production',PUBLIC_ORIGIN:'http://localhost:5173'}),/Invalid configuration/);
  assert.equal(readConfig({...database,AUTH_SECRET:'ab'.repeat(32),NODE_ENV:'production',PUBLIC_ORIGIN:'https://seatledger.example'}).NODE_ENV,'production');
});
