import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('review-version upgrade preserves existing approved organizations and memberships', async () => {
  const pool = createPool(readDatabaseConfig().DATABASE_URL), db = await pool.connect(); let schema;
  try {
    await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    await db.query(await readFile(new URL('../../db/migrations/006_auth_throttling.sql', import.meta.url), 'utf8'));
    const user = (await db.query("INSERT INTO users(email,display_name,password_hash) VALUES($1,'Upgrade owner','fixture-only-password-hash') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0];
    const organization = (await db.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Existing approved stage','APPROVED',$1,clock_timestamp()) RETURNING id", [user.id])).rows[0];
    await db.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER')", [organization.id, user.id]);
    const before = (await db.query('SELECT * FROM organizers WHERE id=$1', [organization.id])).rows[0];
    const membership = (await db.query('SELECT * FROM organizer_memberships WHERE organizer_id=$1', [organization.id])).rows[0];
    await db.query(await readFile(new URL('../../db/migrations/007_organizer_review_versions.sql', import.meta.url), 'utf8'));
    const after = (await db.query('SELECT * FROM organizers WHERE id=$1', [organization.id])).rows[0];
    assert.equal(after.status_version, 0); delete after.status_version; assert.deepEqual(after, before);
    assert.deepEqual((await db.query('SELECT * FROM organizer_memberships WHERE organizer_id=$1', [organization.id])).rows[0], membership);
    await db.query('COMMIT');
  } finally {
    await db.query('ROLLBACK');
    if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    db.release(); await pool.end();
  }
});
