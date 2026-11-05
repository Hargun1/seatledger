import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';

test('allocation migration preserves existing available inventory', async () => {
  const pool = createPool(readConfig().DATABASE_URL);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const schema = `allocation_upgrade_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^allocation_upgrade_[a-f0-9]{32}$/);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query('SELECT set_config($1,$2,true)', ['search_path', `${schema}, public`]);
    for (const file of ['001_foundation.sql', '002_identity_ownership.sql']) {
      await client.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await client.query(await readFile(new URL('../../db/seeds/development.sql', import.meta.url), 'utf8'));
    const columns = 'show_id,venue_seat_id,venue_id,state,price_minor,currency';
    const before = await client.query(`SELECT ${columns} FROM show_seats ORDER BY show_id,venue_seat_id`);
    await client.query(await readFile(new URL('../../db/migrations/003_reservations_bookings.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await client.query(`SELECT ${columns} FROM show_seats ORDER BY show_id,venue_seat_id`)).rows, before.rows);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM show_seats WHERE reservation_id IS NOT NULL OR booking_id IS NOT NULL OR expires_at IS NOT NULL')).rows[0].n, 0);
    assert.equal(before.rowCount, 24);
  } finally {
    try { if (client) { try { await client.query('ROLLBACK'); } finally { client.release(); } } }
    finally { await pool.end(); }
  }
});
