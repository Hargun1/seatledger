import pg from 'pg';
import { instrumentClient, bindTraceCallback } from './observability.js';

export function createPool(connectionString) {
  // Hosted scale-to-zero databases need time to wake and negotiate TLS. Keep
  // transaction/query bounds unchanged; local tests retain their fast failures.
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: process.env.NODE_ENV === 'production' ? 10000 : 1500,
    idleTimeoutMillis: 10000, query_timeout: 2000, application_name: 'seatledger' });
  pool.on('connect', instrumentClient);
  const connect = pool.connect.bind(pool);
  pool.connect = callback => typeof callback === 'function' ? connect(bindTraceCallback(callback)) : connect();
  return pool;
}
