import { validCommand } from './model.js';
import { BookingError } from './client.js';

// Only request identity/intent; never cookies, CSRF tokens, credentials or prices.
export function createRequestJournal(userId, showId, storage = () => globalThis.sessionStorage) {
  const name = `seatledger:request:v1:${userId}:${showId}`;
  return {
    read() {
      try {
        const text = storage().getItem(name); if (text === null) return null;
        if (text.length > 2048) throw new Error();
        const command = JSON.parse(text); if (!validCommand(command, userId, showId)) throw new Error();
        return command;
      } catch { throw new BookingError('STORAGE_UNAVAILABLE'); }
    },
    save(command) {
      try { if (!validCommand(command, userId, showId)) throw new Error(); storage().setItem(name, JSON.stringify(command)); }
      catch { throw new BookingError('STORAGE_UNAVAILABLE'); }
    },
    clear() { try { storage().removeItem(name); } catch { throw new BookingError('STORAGE_UNAVAILABLE'); } }
  };
}
