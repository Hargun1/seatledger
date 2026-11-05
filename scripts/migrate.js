import { createPool } from '../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../apps/api/src/config.js';
import { migrate } from './lib/migrations.js';

// Session advisory locks require a direct connection when hosted behind a
// transaction pooler. Local development keeps the existing DATABASE_URL.
const pool = createPool(readConfig({ ...process.env,
  DATABASE_URL: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL
}).DATABASE_URL);
try { await migrate(pool); }
finally { await pool.end(); }
