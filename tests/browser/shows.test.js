import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

// Authored for local acceptance. Do not infer execution from source syntax.
test('show scheduling UI journey (built React, real API and private PostgreSQL)', { timeout: 120000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL), contexts = [], pageErrors = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '' };
  let db, schema, pool, api, web, browser, owner, staff, outsider, org, event, venue, ny, showId;
  const schedule = () => `${config.PUBLIC_ORIGIN}/organizers/${org.id}/events/${event.id}/shows`;
  const detail = id => schedule() + '/' + id;
  async function scenario(name, work) { let failure; await t.test(name, async () => { try { await work(); } catch (e) { failure = e; throw e; } }); if (failure) throw failure; }
  async function actor() {
    const user = (await pool.query("INSERT INTO users(email,display_name,password_hash) VALUES($1,'Show UI fixture','fixture-only-not-a-password') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0], raw = newToken();
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrfFor(raw, config.AUTH_SECRET))]);
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } }); contexts.push(context);
    await context.route('**/*', route => new URL(route.request().url()).origin === config.PUBLIC_ORIGIN ? route.continue() : route.abort('blockedbyclient'));
    await context.addCookies([{ name: 'seatledger_session', value: raw, url: config.PUBLIC_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message)); return { ...user, context, page };
  }
  async function newVenue(name, zone) {
    const v = (await pool.query("INSERT INTO venues(name,city,timezone,organizer_id) VALUES($1,'Bengaluru',$2,$3) RETURNING id", [name, zone, org.id])).rows[0];
    const section = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [v.id])).rows[0]; await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'A',n FROM generate_series(1,3) n", [v.id, section.id]); return v;
  }
  async function choose(page, name = 'Paper Hall') { await page.getByRole('button', { name: `Choose ${name}`, exact: true }).click(); await expect(page.getByLabel('Venue date and time', { exact: true })).toBeVisible(); }
  async function fill(page, time = '2030-10-30T19:00', price = '750.25') { await page.getByLabel('Venue date and time', { exact: true }).fill(time); await page.getByLabel('Ticket price (INR)', { exact: true }).fill(price); }
  try {
    db = await adminPool.connect(); await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql']) await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await db.query('COMMIT'); const connection = new URL(readDatabaseConfig().DATABASE_URL); connection.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(connection.toString());
    api = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1'); await new Promise((resolve, reject) => { api.once('listening', resolve); api.once('error', reject); });
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } }); config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}), args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
    owner = await actor(); staff = await actor(); outsider = await actor();
    org = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Programme team','APPROVED',$1,clock_timestamp()) RETURNING id", [owner.id])).rows[0];
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER'),($1,$3,'STAFF')", [org.id, owner.id, staff.id]);
    event = (await pool.query("INSERT INTO events(title,category,organizer_id) VALUES('A talk <script>literal</script>','Talks',$1) RETURNING id", [org.id])).rows[0]; venue = await newVenue('Paper Hall', 'Asia/Kolkata'); ny = await newVenue('New York Room', 'America/New_York'); const { page } = owner;
    await scenario('event navigation reaches an empty schedule and preserves escaped content', async () => {
      await page.goto(`${config.PUBLIC_ORIGIN}/organizers/${org.id}`);
      // Accessible names insert spacing around the screen-reader-only title.
      // Check the exact destination as well as the visible action label.
      const scheduleLink = page.getByRole('link', { name: /^Show schedule\s*:/ });
      await expect(scheduleLink).toHaveAttribute('href', `/organizers/${org.id}/events/${event.id}/shows`);
      await scheduleLink.click(); await expect(page).toHaveURL(schedule()); await expect(page.getByText('No shows on this page.', { exact: true })).toBeVisible(); assert.equal(await page.locator('main script').count(), 0);
    });
    await scenario('validation and duplicate submission save one show with converted time and exact paise', async () => {
      await choose(page); await page.getByRole('button', { name: 'Save new show', exact: true }).click(); await expect(page.getByLabel('Venue date and time', { exact: true })).toBeFocused();
      await fill(page); await page.getByRole('button', { name: 'Save new show', exact: true }).evaluate(button => { button.click(); button.click(); }); await expect(page).toHaveURL(/\/shows\/[a-f0-9-]{36}$/); showId = page.url().split('/').at(-1);
      await expect(page.getByRole('button', { name: 'Edit time and price' })).toBeVisible(); const rows = (await pool.query('SELECT starts_at,base_price_minor FROM shows WHERE event_id=$1', [event.id])).rows; assert.equal(rows.length, 1); assert.equal(rows[0].starts_at.toISOString(), '2030-10-30T13:30:00.000Z'); assert.equal(rows[0].base_price_minor, 75025); assert.equal((await pool.query('SELECT count(*)::int AS n FROM show_seats WHERE show_id=$1', [showId])).rows[0].n, 0);
      await page.reload(); await expect(page.getByText('Paper Hall', { exact: true })).toBeVisible();
    });
    await scenario('price-only edit preserves exact saved time and cancel restores the remounted action', async () => {
      await pool.query("UPDATE shows SET starts_at='2030-10-30T13:30:00.123456Z' WHERE id=$1", [showId]); await page.reload();
      await page.getByRole('button', { name: 'Edit time and price' }).click(); await page.getByRole('button', { name: 'Cancel editing' }).click(); await expect(page.getByRole('button', { name: 'Edit time and price' })).toBeFocused();
      await page.getByRole('button', { name: 'Edit time and price' }).click(); await page.getByRole('button', { name: 'Save show changes' }).click(); await expect(page.getByText('There are no changes to save.')).toBeVisible();
      await page.getByLabel('Ticket price (INR)').fill('800'); await page.getByRole('button', { name: 'Save show changes' }).click(); await expect(page.getByText('Show changes saved.', { exact: true })).toBeVisible(); assert.equal((await pool.query("SELECT to_char(starts_at AT TIME ZONE 'UTC','US') AS micros FROM shows WHERE id=$1", [showId])).rows[0].micros, '123456');
    });
    await scenario('a real competing API edit rejects the stale form and hides old controls', async () => {
      await page.getByRole('button', { name: 'Edit time and price' }).click();
      await page.evaluate(async ({ orgId, eventId, showId }) => { const { csrfToken } = await (await fetch('/api/auth/session')).json(); const response = await fetch(`/api/organizers/${orgId}/events/${eventId}/shows/${showId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ expectedRevision: 1, priceMinor: 81000 }) }); if (response.status !== 200) throw new Error('competing fixture edit failed'); }, { orgId: org.id, eventId: event.id, showId });
      await page.getByLabel('Ticket price (INR)').fill('900'); await page.getByRole('button', { name: 'Save show changes' }).click(); await expect(page.getByRole('alert')).toContainText('Someone changed this show'); await expect(page.getByLabel('Ticket price (INR)')).toHaveCount(0); await page.getByRole('button', { name: 'Reload workspace', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit time and price' })).toBeVisible();
    });
    await scenario('lost committed patch response requires recovery without automatic replay', async () => {
      await page.getByRole('button', { name: 'Edit time and price' }).click(); let writes = 0;
      const pattern = `**/api/organizers/${org.id}/events/${event.id}/shows/${showId}`;
      await page.route(pattern, async route => { if (route.request().method() !== 'PATCH') return route.continue(); writes++; await route.fetch(); await route.abort('failed'); });
      await page.getByLabel('Ticket price (INR)').fill('820'); await page.getByRole('button', { name: 'Save show changes' }).click(); await expect(page.getByRole('alert')).toContainText('may already be recorded'); assert.equal(writes, 1); await page.unroute(pattern); await page.getByRole('button', { name: 'Reload workspace', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit time and price' })).toBeVisible(); assert.equal((await pool.query('SELECT base_price_minor FROM shows WHERE id=$1', [showId])).rows[0].base_price_minor, 82000);
    });
    await scenario('daylight saving gaps reject and overlaps need an explicit occurrence', async () => {
      await page.goto(schedule()); await choose(page, 'New York Room'); await fill(page, '2030-03-10T02:30', '0'); await page.getByRole('button', { name: 'Save new show' }).click(); await expect(page.getByText(/This clock time cannot be used/)).toBeVisible();
      await page.getByLabel('Venue date and time', { exact: true }).fill('2030-11-03T01:30'); await page.getByRole('button', { name: 'Save new show' }).click(); await expect(page.getByText('This clock time occurs more than once. Choose the intended occurrence.')).toBeVisible(); await page.getByRole('radio', { name: /Later occurrence/ }).check(); await page.getByRole('button', { name: 'Save new show' }).click(); await expect(page).toHaveURL(/\/shows\/[a-f0-9-]{36}$/);
      const selected = page.url().split('/').at(-1); assert.equal((await pool.query('SELECT starts_at FROM shows WHERE id=$1', [selected])).rows[0].starts_at.toISOString(), '2030-11-03T06:30:00.000Z');
    });
    await scenario('staff and foreign accounts cannot edit; inventory changes make a show read only', async () => {
      await staff.page.goto(detail(showId)); await expect(staff.page.getByText(/Staff access is read only/)).toBeVisible(); await expect(staff.page.getByRole('button', { name: 'Edit time and price' })).toHaveCount(0);
      await outsider.page.goto(detail(showId)); await expect(outsider.page.getByRole('alert')).toContainText('unavailable');
      await pool.query('INSERT INTO show_seats(show_id,venue_seat_id,venue_id,price_minor) SELECT $1,id,venue_id,82000 FROM venue_seats WHERE venue_id=$2', [showId, venue.id]); await page.goto(detail(showId)); await expect(page.getByText(/Inventory or agreements exist/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit time and price' })).toHaveCount(0);
    });
    await scenario('unused removal requires confirmation; narrow screens and expired sessions remain recoverable', async () => {
      await page.goto(schedule()); await choose(page); await fill(page); await page.getByRole('button', { name: 'Save new show' }).click(); await expect(page).toHaveURL(/\/shows\/[a-f0-9-]{36}$/); const removeId = page.url().split('/').at(-1);
      await page.setViewportSize({ width: 320, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.getByRole('button', { name: 'Remove draft show' }).click(); await expect(page.getByRole('heading', { name: 'Remove this draft show?' })).toBeFocused(); await page.getByRole('button', { name: 'Keep show' }).click(); await expect(page.getByRole('button', { name: 'Remove draft show' })).toBeFocused(); await page.getByRole('button', { name: 'Remove draft show' }).click(); await page.getByRole('button', { name: 'Confirm removal' }).click(); await expect(page).toHaveURL(schedule()); assert.equal((await pool.query('SELECT id FROM shows WHERE id=$1', [removeId])).rowCount, 0);
      await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [owner.id]); await page.reload(); await expect(page).toHaveURL(/\/sign-in$/); assert.deepEqual(pageErrors, []);
    });
  } finally {
    for (const context of contexts) await context.close(); await browser?.close(); await web?.close(); if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); } await pool?.end();
    if (db) { await db.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA "${schema}" CASCADE`); } db.release(); } await adminPool.end();
  }
});
