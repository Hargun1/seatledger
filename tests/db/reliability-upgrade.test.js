import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig as readConfig } from '../../apps/api/src/config.js';
import { paymentFixture } from '../helpers/payment-fixture.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('reliability migration preserves existing capture/refund identities',async()=>{
  const pool=createPool(readConfig().DATABASE_URL); let db;
  try {
    db=await pool.connect(); await db.query('BEGIN');
    await installReliabilitySchema(db,'reliability',4);
    const f=await paymentFixture(db), pay=await f.attempt(await f.reservation());
    await f.capture(pay); const refund=await f.refund(pay);
    const snapshot=async()=>({
      payment:(await db.query('SELECT row_to_json(p) AS record FROM payment_attempts p WHERE id=$1',[pay.id])).rows,
      refund:(await db.query('SELECT row_to_json(r) AS record FROM refunds r WHERE id=$1',[refund.id])).rows
    });
    const before=await snapshot();
    // Production legacy rows were committed before a later migration starts.
    // Flush our same-transaction fixture events before ALTER TABLE so the test
    // models that state without leaving permanent fixtures behind.
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query(await readFile(new URL('../../db/migrations/005_reliability_records.sql',import.meta.url),'utf8'));
    assert.deepEqual(await snapshot(),before);
    await db.query('INSERT INTO outbox_events (kind,refund_id,operation_key) VALUES ($1,$2,$3)',['REFUND_CREATE',refund.id,refund.request_key]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    try { if(db){try{await db.query('ROLLBACK');}finally{db.release();}} } finally {await pool.end();}
  }
});
