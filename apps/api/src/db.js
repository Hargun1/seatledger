import pg from 'pg';

export function createPool(connectionString) {
  // Hosted scale-to-zero databases need time to wake and negotiate TLS. Keep
  // transaction/query bounds unchanged; local tests retain their fast failures.
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: process.env.NODE_ENV === 'production' ? 10000 : 1500,
    idleTimeoutMillis: 10000, query_timeout: 2000, application_name: 'seatledger' });
}
