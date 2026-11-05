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

// Authored for local acceptance, not an execution claim. Previous browser-path
// approval restriction has not been bypassed or retried by the agent.
test('local publication review/confirmation and recovery UI', { timeout: 120000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL), contexts = [], pageErrors = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '' };
  let db, schema, pool, api, web, browser, owner, staff, foreign, org, venue;
  const url = event => `${config.PUBLIC_ORIGIN}/organizers/${org.id}/events/${event.id}/publication`;
  const postPath = event => `**/api/organizers/${org.id}/events/${event.id}/publish`;
  const seats = async event => (await pool.query('SELECT count(*)::int AS n FROM show_seats ss JOIN shows s ON s.id=ss.show_id WHERE s.event_id=$1', [event.id])).rows[0].n;
  async function actor() {
    const user = (await pool.query("INSERT INTO users(email,display_name,password_hash) VALUES($1,'Publication UI fixture','fixture-only-not-a-password') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0], raw = newToken();
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrfFor(raw, config.AUTH_SECRET))]);
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } }); contexts.push(context);
    await context.route('**/*', route => new URL(route.request().url()).origin === config.PUBLIC_ORIGIN ? route.continue() : route.abort('blockedbyclient'));
    await context.addCookies([{ name: 'seatledger_session', value: raw, url: config.PUBLIC_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); return { ...user, page };
  }
  async function event(title = 'A programme <script>literal</script>') {
    const e = (await pool.query("INSERT INTO events(title,category,organizer_id) VALUES($1,'Talks',$2) RETURNING id", [title, org.id])).rows[0];
    e.show = (await pool.query("INSERT INTO shows(event_id,venue_id,organizer_id,starts_at,base_price_minor,currency) VALUES($1,$2,$3,'2035-10-30T13:30:00.123456Z',75000,'INR') RETURNING id", [e.id, venue.id, org.id])).rows[0]; return e;
  }
  async function review(page, e) { await page.goto(url(e)); await page.getByRole('button', { name: 'Review saved schedule', exact: true }).click(); await expect(page.getByRole('heading', { name: 'The programme, in full.' })).toBeVisible(); }
  async function confirm(page) { await page.getByRole('button', { name: 'Continue to confirmation', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Publish this programme locally?' })).toBeFocused(); }
  async function scenario(name, work) { let failure; await t.test(name, async () => { try { await work(); } catch (e) { failure = e; throw e; } }); if (failure) throw failure; }
  try {
    db = await adminPool.connect(); await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql']) await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await db.query('COMMIT'); const connection = new URL(readDatabaseConfig().DATABASE_URL); connection.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(connection.toString());
    api = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1'); await new Promise((resolve, reject) => { api.once('listening', resolve); api.once('error', reject); });
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } }); config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}), args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
    owner = await actor(); staff = await actor(); foreign = await actor(); org = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Publication team','APPROVED',$1,clock_timestamp()) RETURNING id", [owner.id])).rows[0];
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER'),($1,$3,'STAFF')", [org.id, owner.id, staff.id]);
    venue = (await pool.query("INSERT INTO venues(name,city,organizer_id) VALUES('Paper Hall','Bengaluru',$1) RETURNING id", [org.id])).rows[0]; const section = (await pool.query("INSERT INTO venue_sections(venue_id,name) VALUES($1,'Main') RETURNING id", [venue.id])).rows[0]; await pool.query("INSERT INTO venue_seats(venue_id,section_id,row_label,seat_number) SELECT $1,$2,'A',n FROM generate_series(1,3) n", [venue.id, section.id]);
    const { page } = owner;
    await scenario('show navigation opens a read-only review; confirmation/cancel writes nothing', async () => {
      const e = await event(); await page.goto(`${config.PUBLIC_ORIGIN}/organizers/${org.id}/events/${e.id}/shows`); await page.getByRole('link', { name: 'Publication review and saved record', exact: true }).click(); await expect(page).toHaveURL(url(e));
      await page.getByRole('button', { name: 'Review saved schedule', exact: true }).click(); await expect(page.getByText('Paper Hall', { exact: false })).toBeVisible(); assert.equal(await page.locator('main script').count(), 0); await confirm(page); assert.equal(await seats(e), 0); await page.getByRole('button', { name: 'Back to review', exact: true }).click(); await expect(page.getByRole('button', { name: 'Continue to confirmation', exact: true })).toBeFocused(); assert.equal(await seats(e), 0);
    });
    await scenario('double confirmation publishes once and receipt reload never repeats POST', async () => {
      const e = await event(), requests = []; const listener = request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/publish')) requests.push(request.postDataJSON()); }; page.on('request', listener);
      await review(page, e); await confirm(page); await page.getByRole('button', { name: 'Confirm local publication', exact: true }).evaluate(button => { button.click(); button.click(); }); await expect(page.getByRole('heading', { name: 'Publication record.', exact: true })).toBeVisible(); assert.equal(requests.length, 1); assert.equal(await seats(e), 3); await page.reload(); await expect(page.getByRole('heading', { name: 'Publication record.', exact: true })).toBeVisible(); assert.equal(requests.length, 1); page.off('request', listener);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='event.published'", [e.id])).rows[0].n, 1);
    });
    await scenario('changed reviewed metadata rejects confirmation and requires a fresh explicit review', async () => {
      const e = await event(); await review(page, e); await confirm(page); await pool.query("UPDATE events SET title='New programme title',publication_revision=publication_revision+1 WHERE id=$1", [e.id]);
      await page.getByRole('button', { name: 'Confirm local publication', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('changed after review'); await expect(page.getByRole('button', { name: 'Confirm local publication' })).toHaveCount(0); assert.equal(await seats(e), 0); await page.getByRole('button', { name: 'Read saved publication', exact: true }).click(); await expect(page.getByRole('button', { name: 'Review saved schedule', exact: true })).toBeVisible(); assert.equal(await seats(e), 0);
    });
    await scenario('lost committed response recovers the saved receipt by GET with no retry', async () => {
      const e = await event(); let posts = 0; await review(page, e); await confirm(page);
      await page.route(postPath(e), async route => { posts++; await route.fetch(); await route.abort('failed'); }); await page.getByRole('button', { name: 'Confirm local publication', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('may already be saved'); assert.equal(posts, 1);
      await page.getByRole('button', { name: 'Read saved publication', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Publication record.', exact: true })).toBeVisible(); assert.equal(posts, 1); assert.equal(await seats(e), 3); await page.unroute(postPath(e));
    });
    await scenario('an uncommitted loss needs a status read before explicit identical-token retry', async () => {
      const e = await event(), tokens = []; await review(page, e); await confirm(page);
      await page.route(postPath(e), async route => { tokens.push(route.request().postDataJSON().reviewToken); if (tokens.length === 1) await route.abort('failed'); else await route.continue(); });
      await page.getByRole('button', { name: 'Confirm local publication', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('may already be saved'); await expect(page.getByRole('button', { name: 'Retry same reviewed publication' })).toHaveCount(0); assert.equal(await seats(e), 0);
      await page.getByRole('button', { name: 'Read saved publication', exact: true }).click(); await page.getByRole('button', { name: 'Retry same reviewed publication', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Publication record.', exact: true })).toBeVisible(); assert.equal(tokens.length, 2); assert.equal(tokens[0], tokens[1]); assert.equal(await seats(e), 3); await page.unroute(postPath(e));
    });
    await scenario('staff and foreign access, legacy records and cancelled history remain truthful', async () => {
      const e = await event(); await review(staff.page, e); await expect(staff.page.getByText('Staff review is read only. An active owner confirms publication.')).toBeVisible(); await expect(staff.page.getByRole('button', { name: 'Continue to confirmation' })).toHaveCount(0); await foreign.page.goto(url(e)); await expect(foreign.page.getByRole('alert')).toContainText('unavailable');
      const legacy = await event(); await pool.query("UPDATE events SET status='PUBLISHED' WHERE id=$1", [legacy.id]); await page.goto(url(legacy)); await expect(page.getByRole('heading', { name: 'Already published.', exact: true })).toBeVisible(); assert.equal(await seats(legacy), 0);
      const closed = await event(); await review(page, closed); await confirm(page); await page.getByRole('button', { name: 'Confirm local publication', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Publication record.', exact: true })).toBeVisible(); await pool.query("UPDATE events SET status='CANCELLED' WHERE id=$1", [closed.id]); await page.reload(); await expect(page.getByText(/original publication record below is historical/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Confirm local publication' })).toHaveCount(0);
    });
    await scenario('narrow confirmation and expired session do not bypass server authority', async () => {
      const e = await event(); await page.setViewportSize({ width: 320, height: 900 }); await review(page, e); await confirm(page); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [owner.id]); await page.getByRole('button', { name: 'Confirm local publication', exact: true }).click(); await expect(page).toHaveURL(/\/sign-in$/); assert.equal(await seats(e), 0); assert.deepEqual(pageErrors, []);
    });
  } finally {
    for (const context of contexts) await context.close(); await browser?.close(); await web?.close(); if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); } await pool?.end(); if (db) { await db.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA "${schema}" CASCADE`); } db.release(); } await adminPool.end();
  }
});
