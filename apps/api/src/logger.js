import pino from 'pino';

// Allowlist log fields at call sites. Do not log request bodies, headers or URLs.
export const logger = pino({ base: { service: 'seatledger-api' }, redact: ['password', 'token', 'secret', 'DATABASE_URL'] });
