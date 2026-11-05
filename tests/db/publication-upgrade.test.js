import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('publication migration preserves legacy published inventory and constrains receipt shape', async () => {
  const pool = createPool(readDatabaseConfig().DATABASE_URL), db = await pool.connect(); let schema;
  try {
    await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql']) await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    const org = '40000000-0000-4000-8000-000000000000';
    const v = (await db.query("INSERT INTO venues(name,city,organizer_id) VALUES('Legacy room','Bengaluru',$1) RETURNING id", [org])).rows[0];
    const section = (await db.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [v.id])).rows[0];
    const seat = (await db.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) VALUES($1,$2,'A',1) RETURNING id", [v.id, section.id])).rows[0];
    const e = (await db.query("INSERT INTO events(title,category,status,organizer_id) VALUES('Already published','Talks','PUBLISHED',$1) RETURNING id", [org])).rows[0];
    const s = (await db.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,'2030-01-01T18:00:00.123456Z') RETURNING id", [e.id, v.id, org])).rows[0];
    await db.query("INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor,currency) VALUES($1,$2,$3,12345,'USD')", [s.id, seat.id, v.id]);
    const snapshot = async () => (await db.query(`SELECT jsonb_build_object(
      'event',(SELECT to_jsonb(e)-'publication_revision'-'published_at'-'publication_token'-'publication_receipt' FROM events e WHERE id=$1),
      'show',(SELECT to_jsonb(s) FROM shows s WHERE id=$2),
      'inventory',(SELECT jsonb_agg(ss) FROM show_seats ss WHERE show_id=$2)) AS data`, [e.id, s.id])).rows[0].data;
    const before = await snapshot(); await db.query(await readFile(new URL('../../db/migrations/010_event_publication.sql', import.meta.url), 'utf8')); assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await db.query('SELECT publication_revision,published_at,publication_token,publication_receipt FROM events WHERE id=$1', [e.id])).rows[0], { publication_revision: 0, published_at: null, publication_token: null, publication_receipt: null });
    for (const [token, receipt] of [[null, {}], ['bad', {}], ['a'.repeat(64), []], ['a'.repeat(64), { text: 'X'.repeat(33000) }], ['a'.repeat(64), null]]) {
      await db.query('SAVEPOINT bad_receipt'); await assert.rejects(db.query('UPDATE events SET published_at=clock_timestamp(),publication_token=$2,publication_receipt=$3 WHERE id=$1', [e.id, token, JSON.stringify(receipt)]), error => error.code === '23514'); await db.query('ROLLBACK TO SAVEPOINT bad_receipt');
    }
    await db.query('COMMIT');
  } finally { await db.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } db.release(); await pool.end(); }
});
