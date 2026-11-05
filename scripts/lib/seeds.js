import { readFile } from 'node:fs/promises';

export function requireDevelopmentSeed(env) {
  if (env.NODE_ENV !== 'development' || env.ALLOW_DEV_SEED !== 'true') {
    throw new Error('Seed refused: requires NODE_ENV=development and ALLOW_DEV_SEED=true. Use a dedicated local database.');
  }
}

export async function seedDevelopment(pool, env) {
  requireDevelopmentSeed(env);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [739105]);
    await client.query(await readFile(new URL('../../db/seeds/development.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../../db/seeds/public-discovery.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
