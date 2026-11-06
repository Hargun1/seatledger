import { z } from 'zod';

export function readDatabaseConfig(env=process.env) {
  const result=z.object({
    NODE_ENV:z.enum(['development','test','production']).default('development'),
    DATABASE_URL:z.string().url().refine(value=>/^postgres(ql)?:/.test(value))
  }).safeParse(env);
  if(!result.success) throw new Error('Invalid database configuration. Check .env against .env.example.');
  return result.data;
}

export function readConfig(env = process.env) {
  const result = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:/.test(value)),
    PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    AUTH_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
    PUBLIC_ORIGIN: z.string().url().refine(value=>{
      const url=new URL(value); return ['http:','https:'].includes(url.protocol) && url.origin===value;
    }).default('http://127.0.0.1:5173'),
    PAYMENT_MODE: z.literal('simulated').default('simulated'),
    METRICS_TOKEN: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    TRACE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(.05),
    CUSTOMER_CANCELLATION_CUTOFF_MINUTES: z.coerce.number().int().min(0).max(10080).default(60),
    SIMULATOR_WEBHOOK_SECRET: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional()
  }).safeParse(env);
  // Never include Zod's input values in an error: they can contain credentials.
  if (!result.success || (result.data.NODE_ENV==='production' && !result.data.PUBLIC_ORIGIN.startsWith('https://'))
    || (result.data.SIMULATOR_WEBHOOK_SECRET && result.data.SIMULATOR_WEBHOOK_SECRET === result.data.AUTH_SECRET)
    || (result.data.METRICS_TOKEN && [result.data.AUTH_SECRET,result.data.SIMULATOR_WEBHOOK_SECRET].includes(result.data.METRICS_TOKEN))) throw new Error('Invalid configuration. Check .env against .env.example.');
  return result.data;
}
