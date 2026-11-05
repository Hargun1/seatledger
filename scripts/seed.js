import { readDatabaseConfig as readConfig } from '../apps/api/src/config.js';
import { createPool } from '../apps/api/src/db.js';
import { requireDevelopmentSeed, seedDevelopment } from './lib/seeds.js';

const config = readConfig();
const env = { NODE_ENV: config.NODE_ENV, ALLOW_DEV_SEED: process.env.ALLOW_DEV_SEED };
requireDevelopmentSeed(env);
const pool = createPool(config.DATABASE_URL);
try {
  await seedDevelopment(pool, env);
  console.log('Development fixtures seeded. Existing records preserved.');
} finally { await pool.end(); }
