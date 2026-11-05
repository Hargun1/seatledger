import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('draft-show upgrade preserves existing catalogue/inventory and rejects malformed price pairs', async () => {
  const pool = createPool(readDatabaseConfig().DATABASE_URL), db = await pool.connect(); let schema;
  try {
    await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql']) await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    const org = '40000000-0000-4000-8000-000000000000';
    const venue = (await db.query("INSERT INTO venues(name,city,organizer_id) VALUES('Imported room','Bengaluru',$1) RETURNING id", [org])).rows[0];
    const section = (await db.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [venue.id])).rows[0];
    const seat = (await db.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) VALUES($1,$2,'A',1) RETURNING id", [venue.id, section.id])).rows[0];
    const event = (await db.query("INSERT INTO events(title,category,organizer_id,status) VALUES('Imported event','Talks',$1,'PUBLISHED') RETURNING id", [org])).rows[0];
    const show = (await db.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,'2030-01-01T18:00:00.123456Z') RETURNING id", [event.id, venue.id, org])).rows[0];
    await db.query("INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor,currency) VALUES($1,$2,$3,12345,'USD')", [show.id, seat.id, venue.id]);
    const snapshot = async () => (await db.query(`SELECT jsonb_build_object(
      'venue',(SELECT to_jsonb(v) FROM venues v WHERE id=$1),
      'event',(SELECT to_jsonb(e) FROM events e WHERE id=$2),
      'show',(SELECT to_jsonb(s)-'revision'-'base_price_minor'-'currency' FROM shows s WHERE id=$3),
      'inventory',(SELECT jsonb_agg(s) FROM show_seats s WHERE show_id=$3)) AS data`, [venue.id, event.id, show.id])).rows[0].data;
    const before = await snapshot(); await db.query(await readFile(new URL('../../db/migrations/009_draft_shows.sql', import.meta.url), 'utf8')); assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await db.query('SELECT revision,base_price_minor,currency FROM shows WHERE id=$1', [show.id])).rows[0], { revision: 0, base_price_minor: null, currency: null });
    for (const [price, currency] of [[null, 'INR'], [1, null], [-1, 'INR'], [100000001, 'INR'], [1, 'rupees']]) {
      await db.query('SAVEPOINT invalid_price');
      await assert.rejects(db.query('UPDATE shows SET base_price_minor=$2,currency=$3 WHERE id=$1', [show.id, price, currency]), error => error.code === '23514');
      await db.query('ROLLBACK TO SAVEPOINT invalid_price');
    }
    await db.query('COMMIT');
  } finally {
    await db.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    db.release(); await pool.end();
  }
});
