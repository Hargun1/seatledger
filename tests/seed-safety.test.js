import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDevelopment } from '../scripts/lib/seeds.js';

test('seed never connects with production environment or without explicit permission', async () => {
  let connections = 0;
  const pool = { connect() { connections++; throw new Error('Must not touch database'); } };
  for (const env of [
    { NODE_ENV: 'production', ALLOW_DEV_SEED: 'true' },
    { NODE_ENV: 'development' },
    { NODE_ENV: 'test', ALLOW_DEV_SEED: 'true' }
  ]) {
    await assert.rejects(seedDevelopment(pool, env), /Seed refused/);
  }
  assert.equal(connections, 0);
});
