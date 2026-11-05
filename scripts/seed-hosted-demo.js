import { readFile } from 'node:fs/promises';
import { createPool } from '../apps/api/src/db.js';
import { readDatabaseConfig } from '../apps/api/src/config.js';

if (process.env.NODE_ENV !== 'production' || process.env.PAYMENT_MODE !== 'simulated'
  || process.env.ALLOW_HOSTED_DEMO_SEED !== 'true') {
  throw new Error('Hosted demo seed requires production, simulated payments and explicit ALLOW_HOSTED_DEMO_SEED=true.');
}
const config = readDatabaseConfig({ ...process.env,
  DATABASE_URL: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
const pool = createPool(config.DATABASE_URL);
const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock($1)', [739105]);
  await db.query(await readFile(new URL('../db/seeds/public-discovery.sql', import.meta.url), 'utf8'));
  await db.query('COMMIT');
  console.log('Synthetic hosted catalogue seeded. Existing records preserved; no sign-in credentials created.');
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { db.release(); await pool.end(); }
