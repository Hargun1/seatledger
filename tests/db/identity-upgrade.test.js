import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';

test('identity migration preserves an existing Phase 0 catalog', async () => {
  const pool = createPool(readConfig().DATABASE_URL);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
    // SQL identifiers cannot be bound as values. This identifier is generated
    // locally from a UUID, validated, and never supplied by a customer.
    assert.match(schema, /^upgrade_[a-f0-9]{32}$/);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query('SELECT set_config($1,$2,true)', ['search_path', `${schema}, public`]);
    await client.query(await readFile(new URL('../../db/migrations/001_foundation.sql', import.meta.url), 'utf8'));
    const venue = randomUUID();
    const event = randomUUID();
    const show = randomUUID();
    await client.query('INSERT INTO venues (id,name,city) VALUES ($1,$2,$3)', [venue, 'Existing venue', 'Bengaluru']);
    await client.query('INSERT INTO events (id,title,category,status) VALUES ($1,$2,$3,$4)', [event, 'Existing event', 'Talks', 'PUBLISHED']);
    await client.query('INSERT INTO shows (id,event_id,venue_id,starts_at) VALUES ($1,$2,$3,$4)', [show, event, venue, '2030-01-01T18:00:00Z']);
    await client.query(await readFile(new URL('../../db/migrations/002_identity_ownership.sql', import.meta.url), 'utf8'));
    const owner = '40000000-0000-4000-8000-000000000000';
    assert.deepEqual((await client.query('SELECT id,name,organizer_id FROM venues')).rows, [{ id: venue, name: 'Existing venue', organizer_id: owner }]);
    assert.deepEqual((await client.query('SELECT id,status,organizer_id FROM events')).rows, [{ id: event, status: 'PUBLISHED', organizer_id: owner }]);
    assert.deepEqual((await client.query('SELECT id,event_id,venue_id,organizer_id FROM shows')).rows, [{ id: show, event_id: event, venue_id: venue, organizer_id: owner }]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM organizer_memberships')).rows[0].n, 0);
  } finally {
    try { if (client) { try { await client.query('ROLLBACK'); } finally { client.release(); } } }
    finally { await pool.end(); }
  }
});
