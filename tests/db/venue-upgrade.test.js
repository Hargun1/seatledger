import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('venue-management upgrade preserves an existing show, layout and inventory', async () => {
  const pool = createPool(readDatabaseConfig().DATABASE_URL), db = await pool.connect(); let schema;
  try {
    await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql']) await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    const org = '40000000-0000-4000-8000-000000000000';
    const venue = (await db.query("INSERT INTO venues(name,city,organizer_id) VALUES('Existing venue','Bengaluru',$1) RETURNING id", [org])).rows[0];
    const section = (await db.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [venue.id])).rows[0];
    const seat = (await db.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) VALUES($1,$2,'A',1) RETURNING id", [venue.id, section.id])).rows[0];
    const event = (await db.query("INSERT INTO events(title,category,organizer_id) VALUES('Existing event','Talks',$1) RETURNING id", [org])).rows[0];
    const show = (await db.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,clock_timestamp()) RETURNING id", [event.id, venue.id, org])).rows[0];
    await db.query('INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) VALUES($1,$2,$3,75000)', [show.id, seat.id, venue.id]);
    await db.query("INSERT INTO audit_events(operation_id,actor_kind,action,entity_type,entity_id) VALUES($1,'SYSTEM','upgrade.before','system',$2)", [randomUUID(), venue.id]);
    const snapshot = async () => (await db.query(`SELECT jsonb_build_object(
      'venue',(SELECT to_jsonb(v)-'revision' FROM venues v WHERE id=$1),
      'section',(SELECT to_jsonb(s) FROM venue_sections s WHERE id=$2),
      'seat',(SELECT to_jsonb(s) FROM venue_seats s WHERE id=$3),
      'show',(SELECT to_jsonb(s) FROM shows s WHERE id=$4),
      'inventory',(SELECT to_jsonb(s) FROM show_seats s WHERE show_id=$4 AND venue_seat_id=$3),
      'audits',(SELECT jsonb_agg(a ORDER BY id) FROM audit_events a)) AS data`, [venue.id, section.id, seat.id, show.id])).rows[0].data;
    const before = await snapshot();
    await db.query(await readFile(new URL('../../db/migrations/008_venue_management.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.query('SELECT revision FROM venues WHERE id=$1', [venue.id])).rows[0].revision, 0);
    await db.query("INSERT INTO audit_events(operation_id,actor_kind,action,entity_type,entity_id) VALUES($1,'SYSTEM','venue.upgrade','venue',$2)", [randomUUID(), venue.id]);
    await db.query('COMMIT');
  } finally {
    await db.query('ROLLBACK');
    if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    db.release(); await pool.end();
  }
});
