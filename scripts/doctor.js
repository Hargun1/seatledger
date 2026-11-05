import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readConfig } from '../apps/api/src/config.js';
import { createPool } from '../apps/api/src/db.js';
import { diagnoseDatabase } from './lib/database-diagnostic.js';

const help = {
  DATABASE_READY: 'Connection, migration checksums and selected required tables pass. Run test:db for real acceptance.',
  DATABASE_OFFLINE: 'PostgreSQL refused the connection. In your terminal run: docker compose up -d db',
  DATABASE_UNREACHABLE: 'Connection timed out. Check the configured database and local Docker status.',
  DATABASE_DNS: 'Database hostname could not be resolved. Check DATABASE_URL locally; do not paste credentials.',
  DATABASE_LOGIN: 'Database login failed. Check the local credentials without posting .env.',
  DATABASE_MISSING: 'The configured database does not exist. Confirm the intended development database.',
  SCHEMA_MISSING: 'Migration ledger is missing in the current search path. Confirm the target, then run: npm run db:migrate',
  MIGRATIONS_PENDING: 'Source migrations are pending. Confirm the target, then run: npm run db:migrate',
  MIGRATION_MISMATCH: 'Applied migration checksum differs. Preserve existing data and investigate; do not edit old migrations.',
  MIGRATIONS_UNKNOWN: 'Database has migrations absent from this checkout. Confirm the checkout and target database.',
  SCHEMA_INCOMPLETE: 'A required table is absent despite the ledger. Investigate schema/search_path; do not reset volumes.',
  DATABASE_PERMISSION: 'Database denied a read. Check the development database account permissions.',
  DATABASE_TIMEOUT: 'A database read exceeded the diagnostic timeout.',
  DATABASE_CHECK_FAILED: 'Database check failed. Inspect the local database safely; raw server errors are intentionally omitted.'
};

let pool;
try {
  let config;
  try { config = readConfig(); }
  catch { console.log('FAIL CONFIG_INVALID: Check .env against .env.example; payments must be simulated. Preserve existing secrets.'); process.exitCode = 1; }
  if (config) {
    console.log('PASS CONFIG: Validated application configuration; payments are simulated.');
    const directory = new URL('../db/migrations/', import.meta.url);
    const expected = [];
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      expected.push({ name, checksum: createHash('sha256').update(sql).digest('hex') });
    }
    pool = createPool(config.DATABASE_URL);
    pool.on('error', () => {}); // No raw idle-client errors in diagnostic output.
    const result = await diagnoseDatabase(pool, expected);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.code}: ${help[result.code]}`);
    process.exitCode = result.ok ? 0 : 1;
  }
} catch {
  console.log('FAIL DIAGNOSTIC_ERROR: Diagnostic could not finish. No infrastructure or schema repair was attempted.');
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
