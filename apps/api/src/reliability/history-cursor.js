import { z } from 'zod';
import { HttpError } from '../http-error.js';

// Shared newest-first history contract: exact SQL timestamp DESC, UUID ASC.
export function decodeHistoryCursor(value) {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Object.keys(parsed).sort().join() !== 'at,id' || !z.uuid().safeParse(parsed.id).success
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.at)
      || parsed.at.startsWith('0000-') || new Date(parsed.at).toISOString().slice(0,19) !== parsed.at.slice(0,19)) throw new Error();
    return parsed;
  } catch { throw new HttpError(400, 'INVALID_REQUEST'); }
}

export function encodeHistoryCursor(row) {
  return Buffer.from(JSON.stringify({ at: row.createdAt, id: row.id })).toString('base64url');
}
