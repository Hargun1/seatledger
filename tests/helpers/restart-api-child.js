import { createPool } from '../../apps/api/src/db.js';
import { createApp } from '../../apps/api/src/app.js';
import { readConfig } from '../../apps/api/src/config.js';

// Test-only child. Ephemeral loopback port and parent-owned private schema.
const config = readConfig();
const schema = new URL(config.DATABASE_URL).searchParams.get('options');
if (!/^-c search_path=auth_test_[a-f0-9]{32},public$/.test(schema || '') || !process.send) throw new Error('Private IPC fixture required');
const pool = createPool(config.DATABASE_URL);
const server = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1', () => {
  process.send({ event: 'ready', port: server.address().port });
});
process.on('disconnect', () => { server.closeAllConnections(); server.close(async () => { await pool.end(); process.exit(0); }); });
