import pg from 'pg';

export function createPool(connectionString) {
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 1500, idleTimeoutMillis: 10000, query_timeout: 2000, application_name: 'seatledger' });
}
