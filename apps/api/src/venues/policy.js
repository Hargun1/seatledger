import { z } from 'zod';

const name = z.string().trim().min(1).max(160);
const city = z.string().trim().min(1).max(120);
const timezone = z.string().trim().min(1).max(64).refine(value => {
  if (!/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
export const revision = z.number().int().min(0).max(2147483647);
export const venueInput = z.object({ name, city, timezone: timezone.default('Asia/Kolkata') }).strict();
export const venuePatch = z.object({ expectedRevision: revision, name: name.optional(), city: city.optional(), timezone: timezone.optional() }).strict()
  .refine(value => ['name', 'city', 'timezone'].some(key => value[key] !== undefined));
export const venueDelete = z.object({ expectedRevision: revision }).strict();
const row = z.object({ label: z.string().trim().min(1).max(8), seats: z.number().int().min(1).max(40) }).strict();
const section = z.object({ name: z.string().trim().min(1).max(80), rows: z.array(row).min(1).max(26) }).strict();
export const layoutInput = z.object({ expectedRevision: revision, sections: z.array(section).min(1).max(20) }).strict().superRefine((value, ctx) => {
  if (new Set(value.sections.map(item => item.name)).size !== value.sections.length) ctx.addIssue({ code: 'custom', message: 'Duplicate sections' });
  let count = 0;
  for (const item of value.sections) {
    if (new Set(item.rows.map(item => item.label)).size !== item.rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate rows' });
    for (const row of item.rows) count += row.seats;
  }
  if (count > 500) ctx.addIssue({ code: 'custom', message: 'At most 500 seats' });
});
