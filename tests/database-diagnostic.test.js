import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseDatabase } from '../scripts/lib/database-diagnostic.js';

const expected = [{ name: '001.sql', checksum: 'expected' }];
function fixture({ ledger = expected, present = true, fail } = {}) {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (fail && sql.startsWith('SELECT name')) throw fail;
      if (sql.startsWith('SELECT name')) return { rows: ledger };
      if (sql.startsWith('SELECT to_regclass')) return { rows: [{ present }] };
      return { rows: [] };
    },
    release(discard) { assert.equal(discard, false); calls.push(['release']); }
  };
  return { pool: { async connect() { return db; } }, calls };
}

test('diagnostic refuses checksum drift, pending and unknown migrations', async () => {
  for (const [ledger, code] of [
    [[{ name: '001.sql', checksum: 'changed' }], 'MIGRATION_MISMATCH'],
    [[], 'MIGRATIONS_PENDING'],
    [[...expected, { name: '999.sql', checksum: 'other' }], 'MIGRATIONS_UNKNOWN']
  ]) {
    const { pool, calls } = fixture({ ledger });
    assert.deepEqual(await diagnoseDatabase(pool, expected), { ok: false, code });
    assert.deepEqual(calls.slice(-2), [['ROLLBACK', undefined], ['release']]);
  }
});

test('diagnostic requires selected real tables and keeps checks read only', async () => {
  for (const present of [false, true]) {
    const { pool, calls } = fixture({ present });
    assert.deepEqual(await diagnoseDatabase(pool, expected), { ok: present, code: present ? 'DATABASE_READY' : 'SCHEMA_INCOMPLETE' });
    assert.equal(calls[0][0], 'BEGIN READ ONLY');
    assert.ok(calls.some(([sql, values]) => sql.includes('to_regclass($1)') && values[0] === 'users'));
    assert.deepEqual(calls.slice(-2), [['ROLLBACK', undefined], ['release']]);
  }
});

test('diagnostic sanitizes connection and SQL failures and releases checked-out clients', async () => {
  const privateMessage = 'postgresql://private:do-not-print@private-host/database';
  const offline = await diagnoseDatabase({ async connect() { throw Object.assign(new Error(privateMessage), { code: 'ECONNREFUSED' }); } }, expected);
  assert.deepEqual(offline, { ok: false, code: 'DATABASE_OFFLINE' });
  for (const [sqlstate, code] of [['42P01', 'SCHEMA_MISSING'], ['42501', 'DATABASE_PERMISSION'], ['XX000', 'DATABASE_CHECK_FAILED']]) {
    const { pool, calls } = fixture({ fail: Object.assign(new Error(privateMessage), { code: sqlstate }) });
    assert.deepEqual(await diagnoseDatabase(pool, expected), { ok: false, code });
    assert.deepEqual(calls.slice(-2), [['ROLLBACK', undefined], ['release']]);
  }
});
