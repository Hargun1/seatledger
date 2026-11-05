import { createPool } from '../apps/api/src/db.js';
import { readDatabaseConfig } from '../apps/api/src/config.js';
import { requireDevelopmentAdmin, grantDevelopmentAdmin } from './lib/dev-admin.js';
import { HttpError } from '../apps/api/src/http-error.js';

let pool;
try {
  const config = readDatabaseConfig();
  const env = { NODE_ENV: config.NODE_ENV, ALLOW_DEV_ADMIN: process.env.ALLOW_DEV_ADMIN };
  const email = process.argv.length === 3 ? process.argv[2] : undefined;
  requireDevelopmentAdmin(env, email);
  pool = createPool(config.DATABASE_URL);
  const result = await grantDevelopmentAdmin(pool, env, email);
  console.log(result.changed ? 'Development administrator access granted.' : 'The development account is already an administrator.');
} catch (error) {
  console.error(error instanceof HttpError ? error.code : 'DEVELOPMENT_ADMIN_FAILED');
  process.exitCode = 1;
} finally { await pool?.end(); }
