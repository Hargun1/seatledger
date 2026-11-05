import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createPool } from './db.js';
import { logger } from './logger.js';

const config = readConfig();
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => logger.error('idle database connection failed'));
const server = createApp({ pool, logger, config }).listen(config.PORT, config.HOST, () => logger.info({ port: config.PORT }, 'API listening'));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close(async () => { await pool.end(); clearTimeout(deadline); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
