import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';

// Requires a migrated and seeded local PostgreSQL database. Never silently skips.
test('real PostgreSQL fixtures and cross-venue inventory constraint', async () => {
  const pool = createPool(readConfig().DATABASE_URL);
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT count(*)::integer AS count FROM show_seats');
    assert.ok(result.rows[0].count >= 24);
    await client.query('BEGIN');
    await assert.rejects(client.query(
      'UPDATE show_seats SET venue_id = $1 WHERE show_id = $2',
      ['10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001']
    ), error => error.code === '23503');
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await assert.rejects(client.query('UPDATE show_seats SET state = $1', ['HELD']), error => error.code === '23514');
    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
});
