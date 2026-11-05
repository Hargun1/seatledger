import { Router } from 'express';
import { loginInput, registerInput } from '@seatledger/shared';
import { HttpError } from '../http-error.js';
import { register, login, logout, readSession } from './service.js';
import { browserMutation, sessionCookie, cookieName, cookieOptions, SESSION_SECONDS, verifyCsrf } from './security.js';
import { consumeAuthLimit, defaultLimits } from './rate-limit.js';

export function createAuthRouter({pool,config,limits=defaultLimits}) {
  const router=Router();
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const credentials=signingUp=>async(req,res)=>{
    await consumeAuthLimit(pool,config.AUTH_SECRET,signingUp?'register_ip':'login_ip',req.ip,signingUp?limits.registerIp:limits.loginIp,signingUp?3600:900);
    const parsed=(signingUp?registerInput:loginInput).safeParse(req.body);
    if(!parsed.success) throw new HttpError(400,'INVALID_REQUEST');
    if(!signingUp) await consumeAuthLimit(pool,config.AUTH_SECRET,'login_email',parsed.data.email,limits.loginEmail,900);
    const result=await (signingUp?register:login)(pool,config,parsed.data,sessionCookie(req,config));
    res.cookie(cookieName(config),result.raw,{...cookieOptions(config),maxAge:SESSION_SECONDS*1000});
    res.status(signingUp?201:200).json({user:result.user,csrfToken:result.csrfToken,expiresAt:result.expiresAt});
  };
  router.post('/register',browserMutation(config),credentials(true));
  router.post('/login',browserMutation(config),credentials(false));
  router.get('/session',async(req,res)=>{
    const session=await readSession(pool,config,sessionCookie(req,config));
    res.json({user:session.user,csrfToken:session.csrfToken,expiresAt:session.expiresAt});
  });
  const revoke=all=>async(req,res)=>{
    const session=await readSession(pool,config,sessionCookie(req,config));
    verifyCsrf(req,session);
    await logout(pool,session,all);
    res.clearCookie(cookieName(config),cookieOptions(config));
    res.status(204).end();
  };
  router.post('/logout',browserMutation(config),revoke(false));
  router.post('/logout-all',browserMutation(config),revoke(true));
  return router;
}
