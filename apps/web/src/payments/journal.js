import { validPaymentCommand } from './model.js';
import { CheckoutError } from './client.js';

// Only immutable request identity; no money, outcomes, session or signing keys.
export function createPaymentJournal(userId, showId, reservationId, storage = () => globalThis.sessionStorage) {
  const name = `seatledger:payment:v1:${userId}:${showId}:${reservationId}`;
  return {
    read() { try { const raw = storage().getItem(name); if (raw === null) return null;
      if (raw.length > 1024) throw new Error(); const value = JSON.parse(raw);
      if (!validPaymentCommand(value, userId, showId, reservationId)) throw new Error(); return value;
    } catch { throw new CheckoutError('STORAGE_UNAVAILABLE'); } },
    save(value) { try { if (!validPaymentCommand(value, userId, showId, reservationId)) throw new Error(); storage().setItem(name, JSON.stringify(value)); }
      catch { throw new CheckoutError('STORAGE_UNAVAILABLE'); } },
    clear() { try { storage().removeItem(name); } catch { throw new CheckoutError('STORAGE_UNAVAILABLE'); } }
  };
}
