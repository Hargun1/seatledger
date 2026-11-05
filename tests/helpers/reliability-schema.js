import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function installReliabilitySchema(db, prefix = 'reliability', through = 5) {
  assert.ok(Number.isInteger(through) && through>=1 && through<=5);
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^(reliability|reliability_concurrent|auth_test)_[a-f0-9]{32}$/);
  // Only a validated, locally generated identifier is interpolated. Never a
  // request value. Caller owns this private schema and its transaction/cleanup.
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query('SELECT set_config($1,$2,false)', ['search_path',`${schema}, public`]);
  for (const file of ['001_foundation.sql','002_identity_ownership.sql','003_reservations_bookings.sql','004_simulated_payment_records.sql','005_reliability_records.sql'].slice(0,through)) {
    await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url),'utf8'));
  }
  return schema;
}
