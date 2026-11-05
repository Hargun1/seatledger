import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { digest } from '../../apps/api/src/auth/security.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('account/session API and CSRF boundary (HTTP + real PostgreSQL)',async t=>{
  const original=readDatabaseConfig().DATABASE_URL;
  const adminPool=createPool(original); let admin,apiPool,schema; const servers=[]; const logs=[];
  const config={NODE_ENV:'test',AUTH_SECRET:randomBytes(32).toString('hex'),PUBLIC_ORIGIN:'https://seatledger.test'};
  const generous={loginIp:1000,loginEmail:1000,registerIp:1000};
  const password='A private test passphrase 2026!';
  const secrets=[password,config.AUTH_SECRET];
  async function server(options={}) {
    const instance=createApp({pool:apiPool,logger:{info:value=>logs.push(value),error:value=>logs.push(value)},config:options.config??config,authLimits:options.limits??generous}).listen(0,'127.0.0.1');
    servers.push(instance); await new Promise((resolve,reject)=>{instance.once('listening',resolve);instance.once('error',reject);});
    return `http://127.0.0.1:${instance.address().port}`;
  }
  function cookie(response) {return response.headers.get('set-cookie')?.split(';')[0];}
  async function post(base,path,body={},options={}) {
    const headers={'Content-Type':'application/json','Origin':config.PUBLIC_ORIGIN,'X-SeatLedger-Client':'web',...options.headers};
    if(options.cookie)headers.Cookie=options.cookie;
    if(options.csrf)headers['X-CSRF-Token']=options.csrf;
    for(const name of options.omit??[])delete headers[name];
    return fetch(`${base}/api/auth/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  }
  const account=()=>({email:`${randomUUID()}@example.invalid`,password,displayName:'Test Reader'});
  async function signup(base,body=account()) {
    const response=await post(base,'register',body); assert.equal(response.status,201,await response.clone().text());
    const data=await response.json(), storedCookie=cookie(response);
    secrets.push(data.csrfToken,storedCookie.split('=')[1]);
    return {body,session:data,cookie:storedCookie,response};
  }
  const session=(base,value)=>fetch(`${base}/api/auth/session`,{headers:value?{Cookie:value}:{}});
  try {
    admin=await adminPool.connect(); await admin.query('BEGIN');
    schema=await installReliabilitySchema(admin,'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/006_auth_throttling.sql',import.meta.url),'utf8'));
    await admin.query('COMMIT');
    const url=new URL(original);url.searchParams.set('options',`-c search_path=${schema},public`);
    apiPool=createPool(url.toString());
    const base=await server();
    await t.test('registration normalizes identity and returns only safe fields with an HttpOnly cookie',async()=>{
      const input={...account(),displayName:'  Reader O\'Brien  '};input.email=`  ${input.email.toUpperCase()}  `;
      const result=await signup(base,input);
      assert.equal(result.session.user.email,input.email.trim().toLowerCase());
      assert.equal(result.session.user.displayName,"Reader O'Brien");assert.equal(result.session.user.role,'CUSTOMER');
      assert.deepEqual(Object.keys(result.session.user).sort(),['displayName','email','id','role']);
      const set=result.response.headers.get('set-cookie');assert.match(set,/HttpOnly/i);assert.match(set,/SameSite=Lax/i);assert.match(set,/Path=\//i);assert.equal(/Domain=/i.test(set),false);
      assert.equal(result.response.headers.get('cache-control'),'no-store');
      const raw=result.cookie.split('=')[1];
      const stored=(await apiPool.query('SELECT token_hash,csrf_token_hash FROM sessions WHERE token_hash=$1',[digest(raw)])).rows[0];
      assert.deepEqual(stored.token_hash,digest(raw));assert.deepEqual(stored.csrf_token_hash,digest(result.session.csrfToken));
      const user=(await apiPool.query('SELECT password_hash FROM users WHERE id=$1',[result.session.user.id])).rows[0];
      assert.match(user.password_hash,/^sl-scrypt-v1\$/);assert.equal(user.password_hash.includes(password),false);
    });
    await t.test('strict input validation blocks role injection, short passwords and bad email',async()=>{
      for(const body of [{...account(),system_role:'ADMIN'},{...account(),password:'short'},{...account(),email:'invalid'}]) assert.equal((await post(base,'register',body)).status,400);
    });
    await t.test('duplicate normalized email is a conflict without issuing another session',async()=>{
      const a=await signup(base);const before=(await apiPool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[a.session.user.id])).rows[0].n;
      const duplicate=await post(base,'register',{...a.body,email:a.body.email.toUpperCase()});
      assert.equal(duplicate.status,409);assert.equal(cookie(duplicate),undefined);
      assert.equal((await apiPool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[a.session.user.id])).rows[0].n,before);
    });
    await t.test('missing/untrusted origin, missing custom header and form content are rejected',async()=>{
      const input=account();
      assert.equal((await post(base,'register',input,{headers:{Origin:'https://attacker.invalid'}})).status,403);
      assert.equal((await post(base,'register',input,{omit:['Origin']})).status,403);
      assert.equal((await post(base,'register',input,{omit:['X-SeatLedger-Client']})).status,403);
      assert.equal((await post(base,'register',input,{headers:{'Content-Type':'text/plain'}})).status,415);
    });
    await t.test('session reload and another API instance recover the same session-bound CSRF token',async()=>{
      const a=await signup(base), other=await server();
      const restored=await session(other,a.cookie);assert.equal(restored.status,200);
      assert.equal((await restored.json()).csrfToken,a.session.csrfToken);
      assert.equal((await session(base)).status,401);
      assert.equal((await session(base,`${a.cookie}; ${a.cookie}`)).status,401);
    });
    await t.test('login rotates the presented browser session and generic failures do not identify accounts',async()=>{
      const a=await signup(base);
      const success=await post(base,'login',{email:a.body.email,password},{cookie:a.cookie});
      assert.equal(success.status,200);assert.notEqual(cookie(success),a.cookie);
      assert.equal((await session(base,a.cookie)).status,401);assert.equal((await session(base,cookie(success))).status,200);
      const wrong=await post(base,'login',{email:a.body.email,password:'An incorrect long passphrase'});
      const unknown=await post(base,'login',{email:account().email,password});
      assert.equal(wrong.status,401);assert.equal(unknown.status,401);assert.deepEqual(await wrong.json(),await unknown.json());
    });
    await t.test('CSRF failures do not revoke a session; valid logout revokes it and clears the cookie',async()=>{
      const a=await signup(base);
      assert.equal((await post(base,'logout',{}, {cookie:a.cookie})).status,403);
      assert.equal((await post(base,'logout',{}, {cookie:a.cookie,csrf:randomBytes(32).toString('base64url')})).status,403);
      const otherDevice=await post(base,'login',{email:a.body.email,password});
      assert.equal(otherDevice.status,200);
      const otherCsrf=(await otherDevice.json()).csrfToken;
      assert.equal((await post(base,'logout',{}, {cookie:a.cookie,csrf:otherCsrf})).status,403);
      assert.equal((await session(base,a.cookie)).status,200);
      const response=await post(base,'logout',{}, {cookie:a.cookie,csrf:a.session.csrfToken});
      assert.equal(response.status,204);assert.match(response.headers.get('set-cookie'),/Expires=/i);
      assert.equal((await session(base,a.cookie)).status,401);
      assert.equal((await session(base,cookie(otherDevice))).status,200);
    });
    await t.test('logout-all revokes sessions from independent devices',async()=>{
      const a=await signup(base), second=await post(base,'login',{email:a.body.email,password});
      const otherCookie=cookie(second);assert.equal(second.status,200);
      assert.equal((await post(base,'logout-all',{}, {cookie:a.cookie,csrf:a.session.csrfToken})).status,204);
      assert.equal((await session(base,a.cookie)).status,401);assert.equal((await session(base,otherCookie)).status,401);
    });
    await t.test('expired sessions and disabled accounts cannot authenticate',async()=>{
      const a=await signup(base);
      await apiPool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[digest(a.cookie.split('=')[1])]);
      assert.equal((await session(base,a.cookie)).status,401);
      const b=await signup(base);await apiPool.query("UPDATE users SET status='DISABLED' WHERE id=$1",[b.session.user.id]);
      assert.equal((await session(base,b.cookie)).status,401);
      assert.equal((await post(base,'login',{email:b.body.email,password})).status,401);
    });
    await t.test('production cookie attributes are set without claiming an HTTPS deployment',async()=>{
      const prod=await server({config:{...config,NODE_ENV:'production'}});
      const a=await signup(prod);const set=a.response.headers.get('set-cookie');
      assert.match(set,/^__Host-seatledger_session=/);assert.match(set,/; Secure/i);assert.match(set,/; HttpOnly/i);assert.equal(/Domain=/i.test(set),false);
    });
    await t.test('database rate limits apply across API instances and reset after the window',async()=>{
      await apiPool.query('TRUNCATE auth_rate_limits'); // Private schema only.
      const limits={loginIp:1,loginEmail:1,registerIp:1}, one=await server({limits}), two=await server({limits});
      const input={email:account().email,password};
      assert.equal((await post(one,'login',input)).status,401);
      const blocked=await post(two,'login',input);assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
      await apiPool.query("UPDATE auth_rate_limits SET expires_at=clock_timestamp()-interval '1 second'");
      assert.equal((await post(two,'login',input)).status,401);
      const rows=await apiPool.query('SELECT bucket_hash FROM auth_rate_limits');assert.ok(rows.rows.every(row=>row.bucket_hash.length===32));
    });
    await t.test('auth audit actions persist and request logs exclude credentials and tokens',async()=>{
      const actions=(await apiPool.query("SELECT DISTINCT action FROM audit_events WHERE action LIKE 'auth.%' ORDER BY action")).rows.map(row=>row.action);
      assert.ok(actions.includes('auth.register'));assert.ok(actions.includes('auth.login'));assert.ok(actions.includes('auth.logout'));assert.ok(actions.includes('auth.logout_all'));
      const text=JSON.stringify(logs);assert.equal(text.includes(password),false);assert.equal(text.includes('csrfToken'),false);assert.equal(text.includes('token_hash'),false);
      assert.ok(secrets.every(secret=>!text.includes(secret)));
    });
  } finally {
    for(const instance of servers)await new Promise(resolve=>instance.close(resolve));
    if(apiPool)await apiPool.end();
    try {
      if(admin){await admin.query('ROLLBACK').catch(()=>{});if(schema){assert.match(schema,/^auth_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}}
    } finally {if(admin)admin.release();await adminPool.end();}
  }
});
