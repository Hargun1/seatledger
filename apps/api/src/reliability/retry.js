// Capped exponential retry with jitter. A zero base is reserved for explicit
// immediate-retry tests; normal workers start at five seconds.
export function retryDelaySeconds(attempt, base = 5, random = Math.random) {
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(base) || base < 0 || base > 3600) throw new TypeError('Invalid retry policy');
  if (!base) return 0;
  const ceiling = Math.min(3600, base * 2 ** Math.min(attempt - 1, 10));
  return Math.max(1, Math.min(3600, Math.round(ceiling * (.8 + .4 * random()))));
}
