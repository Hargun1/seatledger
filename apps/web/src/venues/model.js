export function validZone(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
export function validateMetadata(fields) {
  const data = { name: fields.name.trim(), city: fields.city.trim(), timezone: fields.timezone.trim() }, errors = {};
  if (!data.name || data.name.length > 160) errors.name = 'Use 1–160 characters for the venue name.';
  if (!data.city || data.city.length > 120) errors.city = 'Use 1–120 characters for the city.';
  if (!validZone(data.timezone)) errors.timezone = 'Enter a named timezone, such as Asia/Kolkata or UTC.';
  return { data, errors };
}
export function validatePlan(sections, expectedRevision = 0) {
  const errors = {}, data = []; let total = 0;
  if (!sections.length || sections.length > 20) errors.plan = 'Use between 1 and 20 sections.';
  const names = new Set();
  for (const [i, section] of sections.entries()) {
    const name = section.name.trim(), rows = [], labels = new Set();
    if (!name || name.length > 80 || names.has(name)) errors[`section-${i}`] = 'Use a unique section name, 1–80 characters.';
    names.add(name);
    if (!section.rows.length || section.rows.length > 26) errors.plan = 'Use 1–26 rows per section.';
    for (const [j, row] of section.rows.entries()) {
      const label = row.label.trim(), raw = String(row.seats).trim(), seats = Number(raw);
      if (!label || label.length > 8 || labels.has(label)) errors[`label-${i}-${j}`] = 'Use a unique row label, 1–8 characters.';
      labels.add(label);
      if (!/^\d+$/.test(raw) || !Number.isInteger(seats) || seats < 1 || seats > 40) errors[`seats-${i}-${j}`] = 'Use a whole number from 1 to 40.';
      else total += seats;
      rows.push({ label, seats });
    }
    data.push({ name, rows });
  }
  if (total > 500) errors.plan = 'A venue can contain at most 500 seats.';
  if (!Object.keys(errors).length && new TextEncoder().encode(JSON.stringify({ expectedRevision, sections: data })).length > 16384) errors.plan = 'This plan is too large to send. Use fewer rows or shorter labels.';
  return { data, errors, total, valid: Object.keys(errors).length === 0 };
}
// Never silently convert gaps (seats 1,3) into a different plan (seats 1,2).
export function planFromSaved(sections) {
  if (!sections.length) return [{ name: 'Main', rows: [{ label: 'A', seats: '8' }] }];
  const plan = sections.map(section => {
    const grouped = new Map();
    for (const seat of section.seats) {
      if (!grouped.has(seat.rowLabel)) grouped.set(seat.rowLabel, []);
      grouped.get(seat.rowLabel).push(seat.number);
    }
    const rows = [];
    for (const [label, numbers] of grouped) {
      numbers.sort((a, b) => a - b);
      if (numbers.some((n, i) => n !== i + 1)) return null;
      rows.push({ label, seats: String(numbers.length) });
    }
    return { name: section.name, rows };
  });
  return plan.some(section => !section) || !validatePlan(plan).valid ? null : plan;
}
export function previewSections(plan) {
  const checked = validatePlan(plan);
  if (!checked.valid) return [];
  return checked.data.map((section, i) => ({ id: `proposal-${i}`, name: section.name,
    seats: section.rows.flatMap((row, j) => Array.from({ length: row.seats }, (_, n) => ({ id: `proposal-${i}-${j}-${n}`, rowLabel: row.label, number: n + 1 }))) }));
}
