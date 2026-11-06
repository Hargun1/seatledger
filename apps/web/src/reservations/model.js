import { validId, instant } from '../discovery/model.js';

export function bookingReturnPath(value) {
  if (typeof value !== 'string') return null;
  if (value === '/account/bookings' || value === '/account/payments' || value === '/assistant') return value;
  const eventCancellation=/^\/organizers\/([^/]+)\/events\/([^/]+)\/cancellation$/.exec(value);
  if(eventCancellation)return eventCancellation.slice(1).every(validId)?value.toLowerCase():null;
  const entrance = /^\/organizers\/([^/]+)\/events\/([^/]+)\/shows\/([^/]+)\/(?:check-in|operations)$/.exec(value);
  if (entrance) return entrance.slice(1).every(validId) ? value.toLowerCase() : null;
  const receipt = /^\/account\/bookings\/([^/]+)(?:\/tickets\/print)?$/.exec(value);
  if (receipt) return validId(receipt[1]) ? value.toLowerCase() : null;
  const match = /^\/events\/([^/]+)\/shows\/([^/]+)\/(?:reserve|checkout\/([^/]+))$/.exec(value);
  return match && validId(match[1]) && validId(match[2]) && (!match[3] || validId(match[3])) ? value.toLowerCase() : null;
}
export function validAgreement(value, showId) {
  if (!value || !validId(value.id) || value.id !== value.id.toLowerCase() || value.showId !== showId || value.paymentMode !== 'simulated'
    || !['ACTIVE', 'RELEASED', 'EXPIRED', 'CONFIRMED'].includes(value.status)
    || !(value.status === 'ACTIVE' ? ['ACTIVE', 'EXPIRED'].includes(value.effectiveStatus) : value.effectiveStatus === value.status)
    || !instant(value.createdAt) || !instant(value.expiresAt) || Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== 300000
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || !Number.isSafeInteger(value.totalMinor) || value.totalMinor < 0
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8) return false;
  return value.items.every((s, i) => s && validId(s.id) && s.id === s.id.toLowerCase() && s.id > (value.items[i - 1]?.id || '')
    && s.currency === value.currency && Number.isInteger(s.priceMinor) && s.priceMinor >= 0 && s.priceMinor <= 2147483647)
    && value.items.reduce((sum, s) => sum + s.priceMinor, 0) === value.totalMinor;
}
export function validCommand(cmd, userId, showId) {
  if (!cmd || cmd.userId !== userId || cmd.showId !== showId || !validId(userId) || !validId(showId)
    || typeof cmd.key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(cmd.key)) return false;
  const allowed = ['kind', 'userId', 'showId', 'key', cmd.kind === 'create' ? 'seatIds' : 'reservationId'];
  if (Object.keys(cmd).length !== allowed.length || Object.keys(cmd).some(k => !allowed.includes(k))) return false;
  if (cmd.kind === 'release') return validId(cmd.reservationId);
  return cmd.kind === 'create' && Array.isArray(cmd.seatIds) && cmd.seatIds.length >= 1 && cmd.seatIds.length <= 8
    && cmd.seatIds.every((id, i) => validId(id) && id === id.toLowerCase() && id > (cmd.seatIds[i - 1] || ''));
}
// Conservative display only: count network/read time too; never grant a lease.
export function remainingLabel(expiresAt, asOf, observedAt, now) {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.parse(asOf) - Math.max(0, now - observedAt)) / 1000));
  return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Check expiry';
}
