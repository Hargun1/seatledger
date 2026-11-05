import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

// Prepared for local execution; not run by the agent through the previously
// approval-blocked browser path. All browser-context requests stay local.
test('venue editor journey (built React + real API + PostgreSQL)', { timeout: 120000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL), contexts = [], pageErrors = [];
  let db, schema, pool, api, web, browser, owner, staff, org, venueId;
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '' };
  async function scenario(name, work) {
    let failure;
    await t.test(name, async () => { try { await work(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
  }
  async function actor() {
    const user = (await pool.query("INSERT INTO users(email,display_name,password_hash) VALUES($1,'Venue UI fixture','fixture-only-not-a-login-password') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0];
    const raw = newToken();
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrfFor(raw, config.AUTH_SECRET))]);
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } }); contexts.push(context);
    await context.route('**/*', route => new URL(route.request().url()).origin === config.PUBLIC_ORIGIN ? route.continue() : route.abort('blockedbyclient'));
    await context.addCookies([{ name: 'seatledger_session', value: raw, url: config.PUBLIC_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); return { ...user, page };
  }
  const listUrl = () => `${config.PUBLIC_ORIGIN}/organizers/${org.id}/venues`;
  const detailUrl = id => `${listUrl()}/${id}`;
  async function create(page, name) {
    await page.goto(listUrl()); await page.getByLabel('Venue name', { exact: true }).fill(name); await page.getByLabel('City', { exact: true }).fill('Bengaluru');
    await page.getByRole('button', { name: 'Create venue', exact: true }).click(); await expect(page).toHaveURL(/\/venues\/[a-f0-9-]{36}$/);
    await expect(page.getByRole('button', { name: 'Define seating plan' })).toBeVisible(); return page.url().split('/').at(-1);
  }
  try {
    db = await adminPool.connect(); await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql']) await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await db.query('COMMIT');
    const connection = new URL(readDatabaseConfig().DATABASE_URL); connection.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(connection.toString());
    api = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { api.once('listening', resolve); api.once('error', reject); });
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
    config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
    owner = await actor(); staff = await actor();
    org = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Small Stage team','APPROVED',$1,clock_timestamp()) RETURNING id", [owner.id])).rows[0];
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER'),($1,$3,'STAFF')", [org.id, owner.id, staff.id]);
    const { page } = owner;
    await scenario('anonymous redirect and authenticated organization navigation reach the empty venue directory', async () => {
      const guest = await browser.newContext(); contexts.push(guest);
      await guest.route('**/*', route => new URL(route.request().url()).origin === config.PUBLIC_ORIGIN ? route.continue() : route.abort('blockedbyclient'));
      const guestPage = await guest.newPage();
      await guestPage.goto(listUrl()); await expect(guestPage).toHaveURL(/\/sign-in$/);
      await page.goto(`${config.PUBLIC_ORIGIN}/organizers/${org.id}`);
      await page.getByRole('link', { name: 'Venues & seating', exact: true }).click(); await expect(page.getByText('No venues on this page.', { exact: true })).toBeVisible();
    });
    await scenario('metadata validation and a double submit create exactly one real venue and open its empty plan', async () => {
      await page.getByRole('button', { name: 'Create venue', exact: true }).click(); await expect(page.getByLabel('Venue name', { exact: true })).toBeFocused();
      await page.getByLabel('Venue name', { exact: true }).fill('A room <img src=x onerror=alert(1)>'); await page.getByLabel('City', { exact: true }).fill('Bengaluru');
      await page.getByLabel('Named timezone').fill('+05:30'); await page.getByRole('button', { name: 'Create venue', exact: true }).click(); await expect(page.getByLabel('Named timezone')).toBeFocused();
      await page.getByLabel('Named timezone').fill('Asia/Kolkata');
      let posts = 0; const count = request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/venues')) posts++; };
      page.on('request', count); await page.getByRole('button', { name: 'Create venue', exact: true }).evaluate(button => { button.click(); button.click(); });
      await expect(page).toHaveURL(/\/venues\/[a-f0-9-]{36}$/); venueId = page.url().split('/').at(-1);
      await expect(page.getByRole('heading', { name: 'A room <img src=x onerror=alert(1)>', exact: true })).toBeVisible();
      assert.equal(await page.locator('main img').count(), 0); assert.equal(posts, 1); page.off('request', count);
      await expect(page.getByText('No seating plan saved yet.', { exact: true })).toBeVisible();
    });
    await scenario('row proposal is not saved until confirmation; cancellation restores editing focus', async () => {
      await page.getByRole('button', { name: 'Define seating plan' }).click(); await page.getByRole('button', { name: 'Add row', exact: true }).click();
      await page.getByLabel('Row label', { exact: true }).nth(1).fill('B'); await page.getByLabel('Seats in row', { exact: true }).nth(1).fill('2');
      await expect(page.getByText('Not saved', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Review seating plan' }).click(); await expect(page.getByRole('heading', { name: 'Replace the saved plan?' })).toBeFocused();
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_seats WHERE venue_id=$1', [venueId])).rows[0].n, 0);
      await page.getByRole('button', { name: 'Continue editing' }).click(); await expect(page.getByRole('button', { name: 'Review seating plan' })).toBeFocused();
      await page.getByRole('button', { name: 'Review seating plan' }).click();
      await page.getByRole('button', { name: 'Confirm seating plan' }).evaluate(button => { button.click(); button.click(); });
      await expect(page.getByText('Seating plan saved.', { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Saved seating plan' })).toBeVisible();
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_seats WHERE venue_id=$1', [venueId])).rows[0].n, 10);
      assert.equal((await pool.query('SELECT revision FROM venues WHERE id=$1', [venueId])).rows[0].revision, 1);
      await page.reload(); await expect(page.getByRole('heading', { name: 'Saved seating plan' })).toBeVisible();
    });
    await scenario('metadata patch preserves physical seats and no-change submit sends no patch', async () => {
      const before = (await pool.query('SELECT id FROM venue_seats WHERE venue_id=$1 ORDER BY id', [venueId])).rows;
      await page.getByRole('button', { name: 'Edit venue details' }).click(); await page.getByRole('button', { name: 'Save venue details' }).click(); await expect(page.getByText('There are no changes to save.')).toBeVisible();
      await page.getByLabel('City', { exact: true }).fill('Mysuru'); await page.getByRole('button', { name: 'Save venue details' }).click();
      await expect(page.getByText('Venue details saved.', { exact: true })).toBeVisible();
      assert.deepEqual((await pool.query('SELECT id FROM venue_seats WHERE venue_id=$1 ORDER BY id', [venueId])).rows, before);
    });
    await scenario('another API mutation invalidates an open metadata form without silently retrying it', async () => {
      await page.getByRole('button', { name: 'Edit venue details' }).click(); await page.getByLabel('City', { exact: true }).fill('Old form intention');
      const revision = (await pool.query('SELECT revision FROM venues WHERE id=$1', [venueId])).rows[0].revision;
      const status = await page.evaluate(async ({ organizationId, venueId, revision }) => {
        const session = await (await fetch('/api/auth/session')).json();
        return (await fetch(`/api/organizers/${organizationId}/venues/${venueId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ expectedRevision: revision, city: 'Latest city' }) })).status;
      }, { organizationId: org.id, venueId, revision }); assert.equal(status, 200);
      await page.getByRole('button', { name: 'Save venue details' }).click(); await expect(page.getByRole('alert')).toHaveText('Someone changed this venue. Reload it before making another change.');
      assert.equal((await pool.query('SELECT city FROM venues WHERE id=$1', [venueId])).rows[0].city, 'Latest city');
      await page.getByRole('button', { name: 'Reload workspace', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit seating plan' })).toBeVisible();
    });
    await scenario('a show created after rendering blocks replacement and recovery displays a locked plan', async () => {
      await page.getByRole('button', { name: 'Edit seating plan' }).click(); await page.getByLabel('Seats in row', { exact: true }).first().fill('6'); await page.getByRole('button', { name: 'Review seating plan' }).click();
      const event = (await pool.query("INSERT INTO events(title,category,organizer_id) VALUES('Fixture show','Talks',$1) RETURNING id", [org.id])).rows[0];
      await pool.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [event.id, venueId, org.id]);
      await page.getByRole('button', { name: 'Confirm seating plan' }).click(); await expect(page.getByRole('alert')).toHaveText('A show now uses this venue. Its details and seating plan are locked.');
      await page.getByRole('button', { name: 'Reload workspace', exact: true }).click(); await expect(page.getByText('Used by a show · Locked', { exact: true })).toBeVisible();
      assert.equal(await page.getByRole('button', { name: 'Edit seating plan' }).count(), 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_seats WHERE venue_id=$1', [venueId])).rows[0].n, 10);
    });
    await scenario('staff browse read-only venue data and foreign references remain unavailable', async () => {
      await staff.page.goto(detailUrl(venueId)); await expect(staff.page.getByRole('heading', { name: 'Saved seating plan' })).toBeVisible();
      assert.equal(await staff.page.getByRole('button', { name: 'Edit venue details' }).count(), 0);
      await staff.page.goto(listUrl()); assert.equal(await staff.page.getByRole('button', { name: 'Create venue' }).count(), 0);
      const foreign = await actor(); await foreign.page.goto(detailUrl(venueId)); await expect(foreign.page.getByRole('alert')).toHaveText('This workspace is unavailable to your account.');
    });
    await scenario('unused venue removal supports cancellation then returns to a freshly read directory', async () => {
      const removable = await create(page, 'A temporary room');
      const trigger = page.getByRole('button', { name: 'Remove unused venue' }); await trigger.click();
      await page.getByRole('button', { name: 'Keep venue', exact: true }).click(); await expect(trigger).toBeFocused();
      await trigger.click(); await page.getByRole('button', { name: 'Confirm removal' }).click(); await expect(page).toHaveURL(listUrl());
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM venues WHERE id=$1', [removable])).rows[0].n, 0);
    });
    await scenario('lost committed-save response clears the editor and read recovery finds one saved plan', async () => {
      const uncertain = await create(page, 'Response-loss room'); await page.getByRole('button', { name: 'Define seating plan' }).click(); await page.getByRole('button', { name: 'Review seating plan' }).click();
      let puts = 0; const pattern = `**/api/organizers/${org.id}/venues/${uncertain}/layout`;
      await page.route(pattern, async route => { puts++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); });
      await page.getByRole('button', { name: 'Confirm seating plan' }).click(); await expect(page.getByRole('alert')).toContainText('may already be recorded');
      assert.equal(await page.getByRole('button', { name: 'Confirm seating plan' }).count(), 0); assert.equal(puts, 1);
      await page.unroute(pattern); await page.getByRole('button', { name: 'Reload workspace', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Saved seating plan' })).toBeVisible();
      assert.equal((await pool.query('SELECT revision FROM venues WHERE id=$1', [uncertain])).rows[0].revision, 1);
    });
    let legacy;
    await scenario('nonconsecutive imported seats are preserved until an explicit new proposal is started', async () => {
      legacy = (await pool.query("INSERT INTO venues(name,city,organizer_id) VALUES($1,'Bengaluru',$2) RETURNING id", ['W'.repeat(100), org.id])).rows[0];
      const section = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Legacy') RETURNING id", [legacy.id])).rows[0];
      await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) VALUES($1,$2,'A',1),($1,$2,'A',3)", [legacy.id, section.id]);
      await page.goto(detailUrl(legacy.id)); await page.getByRole('button', { name: 'Edit seating plan' }).click();
      await expect(page.getByText('This saved plan cannot be edited as consecutive row counts.', { exact: true })).toBeVisible(); assert.equal(await page.getByRole('button', { name: 'Review seating plan' }).count(), 0);
      await page.getByRole('button', { name: 'Start a new plan' }).click(); await expect(page.getByText('Not saved', { exact: true })).toBeVisible();
      assert.deepEqual((await pool.query('SELECT seat_number FROM venue_seats WHERE venue_id=$1 ORDER BY seat_number', [legacy.id])).rows.map(row => row.seat_number), [1, 3]);
    });
    await scenario('320px proposal view fits and expired confirmation recovers through sign-in', async () => {
      await page.setViewportSize({ width: 320, height: 850 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: 'Review seating plan' }).click(); await expect(page.getByRole('heading', { name: 'Replace the saved plan?' })).toBeFocused();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL", [owner.id]);
      await page.getByRole('button', { name: 'Confirm seating plan' }).click(); await expect(page).toHaveURL(/\/sign-in$/);
      assert.equal((await pool.query('SELECT revision FROM venues WHERE id=$1', [legacy.id])).rows[0].revision, 0);
    });
    assert.deepEqual(pageErrors, []); console.log(`Venue browser verified: ${browser.version()}; local HTTP/private PostgreSQL.`);
  } finally {
    for (const context of contexts) await context.close(); await browser?.close();
    if (web) await new Promise(resolve => web.httpServer.close(resolve));
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await pool?.end();
    if (db) { await db.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA "${schema}" CASCADE`); } db.release(); }
    await adminPool.end();
  }
});
