import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';
import { paymentFixture } from '../helpers/payment-fixture.js';

test('payment schema upgrades without altering existing reservation agreements', async () => {
  const pool = createPool(readConfig().DATABASE_URL);
  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    const schema = `payment_upgrade_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^payment_upgrade_[a-f0-9]{32}$/);
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query('SELECT set_config($1,$2,true)', ['search_path', `${schema}, public`]);
    for (const name of ['001_foundation.sql','002_identity_ownership.sql','003_reservations_bookings.sql']) {
      await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const f = await paymentFixture(db);
    const res = await f.reservation();
    const before = (await db.query('SELECT row_to_json(r) AS agreement FROM reservations r WHERE id=$1', [res.id])).rows;
    await db.query(await readFile(new URL('../../db/migrations/004_simulated_payment_records.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await db.query('SELECT row_to_json(r) AS agreement FROM reservations r WHERE id=$1', [res.id])).rows, before);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_attempts')).rows[0].n, 0);
  } finally {
    try { if (db) { try { await db.query('ROLLBACK'); } finally { db.release(); } } }
    finally { await pool.end(); }
  }
});
