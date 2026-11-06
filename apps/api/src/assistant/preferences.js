import { HttpError } from '../http-error.js';

export const defaultPreferences = () => ({ category: null, city: null, when: 'any', fromDay: null, toDay: null,
  ticketCount: 1, budgetMinor: null, budgetScope: 'total', adjacent: null, preference: 'cheapest' });
const shiftDay = (day, offset) => new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

export function mergePreferences(previous, update) {
  const value = { ...defaultPreferences(), ...previous };
  for (const [key, field] of Object.entries(update)) if (field !== null) value[key] = field;
  if (value.budgetScope === 'none') { value.budgetMinor = null; value.budgetScope = 'total'; }
  if (value.when !== 'dates') { value.fromDay = null; value.toDay = null; }
  if (value.when === 'dates' && (!value.fromDay || !value.toDay || value.toDay < value.fromDay
    || Date.parse(value.toDay) - Date.parse(value.fromDay) > 31 * 86400000)) throw new HttpError(400, 'INVALID_DATE_RANGE');
  return value;
}

// This edition searches calendar days in Asia/Kolkata. Exact timestamp
// filtering follows the existing service's broader UTC-day search.
export function dateWindow(preferences, now = new Date()) {
  if (preferences.when === 'any') return null;
  const today = new Date(now.getTime() + 19800000).toISOString().slice(0, 10);
  let from = today, to = today;
  if (preferences.when === 'tomorrow') from = to = shiftDay(today, 1);
  if (['this_weekend', 'next_weekend'].includes(preferences.when)) {
    const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
    const distance = weekday === 0 ? -1 : (6 - weekday + 7) % 7;
    from = shiftDay(today, distance + (preferences.when === 'next_weekend' ? 7 : 0)); to = shiftDay(from, 1);
  }
  if (preferences.when === 'dates') { from = preferences.fromDay; to = preferences.toDay; }
  return { fromDay: from, toDay: to, timezone: 'Asia/Kolkata',
    start: new Date(from + 'T00:00:00+05:30').toISOString(), end: new Date(shiftDay(to, 1) + 'T00:00:00+05:30').toISOString() };
}

export function recommendSeatGroups(map, preferences, limit = 3) {
  const count = preferences.ticketCount, adjacent = preferences.adjacent ?? count > 1;
  const available = map.seats.filter(seat => seat.state === 'AVAILABLE'
    && (preferences.budgetMinor === null || seat.currency === 'INR')
    && (preferences.budgetMinor === null || preferences.budgetScope !== 'per_ticket' || seat.priceMinor <= preferences.budgetMinor));
  const candidates = [];
  function add(seats, center = 0) {
    if (seats.length !== count || new Set(seats.map(seat => seat.currency)).size !== 1) return;
    const totalMinor = seats.reduce((sum, seat) => sum + seat.priceMinor, 0);
    const maximum = preferences.budgetMinor === null ? Infinity : preferences.budgetMinor * (preferences.budgetScope === 'per_ticket' ? count : 1);
    if (!Number.isSafeInteger(totalMinor) || totalMinor > maximum) return;
    candidates.push({ seats, totalMinor, currency: seats[0].currency, adjacent, center });
  }
  const rows = new Map();
  for (const seat of available) {
    const key = JSON.stringify([seat.sectionId, seat.row]);
    if (!rows.has(key)) rows.set(key, []); rows.get(key).push(seat);
  }
  if (adjacent || count === 1) {
    for (const row of rows.values()) {
      row.sort((a, b) => a.number - b.number);
      const physical = map.seats.filter(seat => seat.sectionId === row[0].sectionId && seat.row === row[0].row);
      const middle = (Math.min(...physical.map(seat => seat.number)) + Math.max(...physical.map(seat => seat.number))) / 2;
      for (let index = 0; index <= row.length - count; index++) {
        const seats = row.slice(index, index + count);
        if (seats.every((seat, position) => !position || seat.number === seats[position - 1].number + 1))
          add(seats, Math.abs((seats[0].number + seats.at(-1).number) / 2 - middle));
      }
    }
  } else {
    for (const currency of new Set(available.map(seat => seat.currency)))
      add(available.filter(seat => seat.currency === currency).sort((a, b) => a.priceMinor - b.priceMinor || a.id.localeCompare(b.id)).slice(0, count));
  }
  candidates.sort((a, b) => (preferences.preference === 'center' ? a.center - b.center : 0)
    || a.totalMinor - b.totalMinor || a.seats.map(seat => seat.id).join().localeCompare(b.seats.map(seat => seat.id).join()));
  return candidates.slice(0, limit).map(({ center, ...value }) => value);
}
