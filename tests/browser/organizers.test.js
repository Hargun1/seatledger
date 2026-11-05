import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';

test('organizer workspace (built React + browser + API + PostgreSQL)', { timeout: 120000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL);
  let admin, pool, schema, api, web, browser, context, owner, reviewer, organization, eventId;
  const pageErrors = [], email = `${randomUUID()}@example.invalid`;
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '' };
  async function scenario(name, work) {
    let failure;
    await t.test(name, async () => { try { await work(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
  }
  async function visual(page, name) {
    if (process.env.SEATLEDGER_VISUAL_CHECK !== 'true') return;
    const dir = new URL('../../test-results/organizer-visual/', import.meta.url);
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, dir)), fullPage: true });
  }
  const approve = () => pool.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1", [organization.id, reviewer]);
  const eventsUrl = () => `${config.PUBLIC_ORIGIN}/organizers/${organization.id}`;
  async function eventCount(title) { return (await pool.query('SELECT count(*)::int AS n FROM events WHERE title=$1', [title])).rows[0].n; }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN');
    schema = await installReliabilitySchema(admin, 'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/006_auth_throttling.sql', import.meta.url), 'utf8'));
    await admin.query(await readFile(new URL('../../db/migrations/007_organizer_review_versions.sql', import.meta.url), 'utf8'));
    for (const name of ['008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT');
    const connection = new URL(readDatabaseConfig().DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(connection.toString());
    api = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { api.once('listening', resolve); api.once('error', reject); });
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
    config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
    context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
    // This acceptance journey needs no external resources or diagnostics.
    // Abort every browser-context request outside the exact private app origin.
    await context.route('**/*', route => new URL(route.request().url()).origin === config.PUBLIC_ORIGIN ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await scenario('anonymous redirect and real registration lead to the organizer empty state', async () => {
      await page.goto(`${config.PUBLIC_ORIGIN}/organizers`); await expect(page).toHaveURL(/\/sign-in$/);
      await page.getByRole('link', { name: 'Create an account', exact: true }).click();
      await page.getByLabel('Your name', { exact: true }).fill('Mira, Small Stage');
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill('A memorable workroom passphrase 2026!');
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByRole('link', { name: 'Organize an evening' }).click();
      await expect(page.getByText('No organizations to show yet.', { exact: true })).toBeVisible();
      owner = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
      reviewer = (await pool.query("INSERT INTO users(email,display_name,password_hash,system_role) VALUES($1,'Fixture reviewer',$2,'ADMIN') RETURNING id", [`${randomUUID()}@example.invalid`, 'fixture-only-not-a-valid-password-hash'])).rows[0].id;
    });
    await scenario('validated organization request commits once despite double submit and reload shows pending', async () => {
      await page.getByRole('button', { name: 'Request organization access' }).click();
      await expect(page.getByLabel('Organization name')).toBeFocused();
      await expect(page.getByText('Enter an organization name between 1 and 160 characters.')).toBeVisible();
      await page.getByLabel('Organization name').fill('Small Stage & Friends');
      let posts = 0;
      const count = request => { if (new URL(request.url()).pathname === '/api/organizers' && request.method() === 'POST') posts++; };
      page.on('request', count);
      await page.getByRole('button', { name: 'Request organization access' }).evaluate(button => { button.click(); button.click(); });
      await expect(page.getByText('Request received. Your organization is awaiting administrator review.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Small Stage & Friends' })).toBeVisible();
      page.off('request', count); assert.equal(posts, 1);
      organization = (await pool.query('SELECT id,name FROM organizers WHERE name=$1', ['Small Stage & Friends'])).rows[0];
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='organizer.requested' AND entity_id=$1", [organization.id])).rows[0].n, 1);
      await page.reload(); await expect(page.getByText('Awaiting review', { exact: true })).toBeVisible();
      assert.equal(await page.getByRole('link', { name: 'Open events' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Request organization access' }).count(), 0);
      await visual(page, 'desktop-pending');
    });
    await scenario('approval is reflected after refresh and a direct reload reconstructs scoped owner access', async () => {
      await approve(); // Private fixture transition; administrator UI is a later slice.
      await page.getByRole('button', { name: 'Refresh workspace' }).click();
      await page.getByRole('link', { name: 'Open events' }).click();
      await expect(page.getByRole('heading', { name: 'Events in the making.' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save new draft' })).toBeVisible();
      await page.reload(); await expect(page.getByText('OWNER ACCESS', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Save new draft' }).click();
      await expect(page.getByLabel('Event title')).toBeFocused();
      await expect(page.getByText('Enter a title between 1 and 200 characters.')).toBeVisible();
    });
    await scenario('draft creation is real, escaped, private and double-click guarded', async () => {
      const title = 'An evening <img src=x onerror=alert(1)>';
      await page.getByLabel('Event title').fill(title); await page.getByLabel('Category', { exact: true }).fill('Talks');
      await page.getByRole('button', { name: 'Save new draft' }).evaluate(button => { button.click(); button.click(); });
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      assert.equal(await page.locator('main img').count(), 0); assert.equal(await eventCount(title), 1);
      const row = (await pool.query('SELECT id,status FROM events WHERE title=$1', [title])).rows[0]; eventId = row.id; assert.equal(row.status, 'DRAFT');
      await visual(page, 'desktop-events');
    });
    await scenario('editing sends only changed fields and preserves a concurrent different-field change', async () => {
      await page.getByRole('button', { name: /^Edit draft/ }).click();
      await expect(page.getByLabel('Event title')).toBeFocused();
      await page.getByRole('button', { name: 'Save draft changes' }).click();
      await expect(page.getByText('There are no changes to save.')).toBeVisible();
      await pool.query('UPDATE events SET title=$2 WHERE id=$1', [eventId, 'A title updated by another editor']);
      await page.getByLabel('Category', { exact: true }).fill('Music');
      const patch = page.waitForRequest(request => request.method() === 'PATCH');
      await page.getByRole('button', { name: 'Save draft changes' }).click();
      assert.deepEqual((await patch).postDataJSON(), { category: 'Music' });
      await expect(page.getByRole('heading', { name: 'A title updated by another editor' })).toBeVisible();
      assert.deepEqual((await pool.query('SELECT title,category FROM events WHERE id=$1', [eventId])).rows[0], { title: 'A title updated by another editor', category: 'Music' });
      await expect(page.getByRole('button', { name: 'Save new draft' })).toBeVisible();
    });
    await scenario('staff see read-only controls and a forged mutation still fails at the API', async () => {
      await pool.query("UPDATE organizer_memberships SET role='STAFF' WHERE organizer_id=$1 AND user_id=$2", [organization.id, owner]);
      await page.reload(); await expect(page.getByText('STAFF / READ ONLY', { exact: true })).toBeVisible();
      assert.equal(await page.getByRole('button', { name: /^Save|^Edit draft/ }).count(), 0);
      const status = await page.evaluate(async id => {
        const session = await (await fetch('/api/auth/session')).json();
        return (await fetch(`/api/organizers/${id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ title: 'Forged staff write', category: 'Talks' }) })).status;
      }, organization.id);
      assert.equal(status, 403); assert.equal(await eventCount('Forged staff write'), 0);
      await pool.query("UPDATE organizer_memberships SET role='OWNER' WHERE organizer_id=$1 AND user_id=$2", [organization.id, owner]);
      await page.reload(); await expect(page.getByRole('button', { name: 'Save new draft' })).toBeVisible();
    });
    await scenario('suspension after render blocks a write, hides stale controls and appears in the directory', async () => {
      await page.getByLabel('Event title').fill('Blocked after suspension'); await page.getByLabel('Category', { exact: true }).fill('Talks');
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [organization.id]);
      await page.getByRole('button', { name: 'Save new draft' }).click();
      await expect(page.getByRole('alert')).toContainText('pending or suspended');
      assert.equal(await page.getByLabel('Event title').count(), 0); assert.equal(await eventCount('Blocked after suspension'), 0);
      await page.getByRole('link', { name: 'Your organizations' }).click();
      await expect(page.getByText('Suspended', { exact: true })).toBeVisible();
      await approve(); await page.goto(eventsUrl()); await expect(page.getByRole('button', { name: 'Save new draft' })).toBeVisible();
    });
    await scenario('foreign and malformed deep links show safe access errors without revealing another tenant', async () => {
      const foreign = (await pool.query("INSERT INTO organizers(name,status,approved_by,approved_at) VALUES('Private foreign team','APPROVED',$1,clock_timestamp()) RETURNING id", [reviewer])).rows[0];
      for (const id of [foreign.id, 'not-a-uuid']) {
        await page.goto(`${config.PUBLIC_ORIGIN}/organizers/${id}`);
        await expect(page.getByRole('alert')).toHaveText('This workspace is unavailable to your account.');
        assert.equal(await page.getByText('Private foreign team').count(), 0); assert.equal(await page.getByLabel('Event title').count(), 0);
      }
      await page.goto(eventsUrl()); await expect(page.getByRole('button', { name: 'Save new draft' })).toBeVisible();
    });
    await scenario('a lost committed-save response requires read recovery and never automatically repeats POST', async () => {
      let posts = 0;
      const pattern = `**/api/organizers/${organization.id}/events`;
      await page.route(pattern, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        posts++; const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed');
      });
      await page.getByLabel('Event title').fill('Saved with a lost response'); await page.getByLabel('Category', { exact: true }).fill('Talks');
      await page.getByRole('button', { name: 'Save new draft' }).click();
      await expect(page.getByRole('alert')).toContainText('may already be recorded');
      assert.equal(await page.getByRole('button', { name: 'Save new draft' }).count(), 0); assert.equal(await eventCount('Saved with a lost response'), 1);
      await page.unroute(pattern); await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Saved with a lost response' })).toBeVisible();
      assert.equal(posts, 1); assert.equal(await eventCount('Saved with a lost response'), 1);
    });
    await scenario('failed and malformed list responses are distinct from empty data and recover without a write', async () => {
      const pattern = `**/api/organizers/${organization.id}/events?*`;
      await page.route(pattern, route => route.abort('failed')); await page.reload();
      await expect(page.getByRole('alert')).toHaveText('We could not reach the workspace.');
      assert.equal(await page.getByText('No events on this page.').count(), 0);
      await page.unroute(pattern); await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save new draft' })).toBeVisible();
      await page.route(pattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) }));
      await page.reload(); await expect(page.getByRole('alert')).toHaveText('We could not confirm the workspace response.');
      await page.unroute(pattern); await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save new draft' })).toBeVisible();
    });
    await scenario('real cursor pages remain bounded and published/cancelled rows have no edit controls', async () => {
      for (let i = 0; i < 21; i++) await pool.query("INSERT INTO events(title,category,organizer_id,status) VALUES($1,'Theatre',$2,$3)", [`Programme ${i}`, organization.id, i === 0 ? 'PUBLISHED' : i === 1 ? 'CANCELLED' : 'DRAFT']);
      const expected = (await pool.query('SELECT title,status FROM events WHERE organizer_id=$1 ORDER BY id', [organization.id])).rows;
      await page.reload(); await expect(page.locator('.event-list>li')).toHaveCount(20);
      assert.deepEqual(await page.locator('.event-list h3').allTextContents(), expected.slice(0, 20).map(row => row.title));
      await page.getByRole('button', { name: 'Next page' }).click();
      await expect(page.locator('.event-list>li')).toHaveCount(expected.length - 20);
      assert.deepEqual(await page.locator('.event-list h3').allTextContents(), expected.slice(20).map(row => row.title));
      await page.getByRole('button', { name: 'First page' }).click(); await expect(page.locator('.event-list>li')).toHaveCount(20);
      for (const row of expected.slice(0, 20).filter(row => row.status !== 'DRAFT')) {
        assert.equal(await page.locator('.event-list>li').filter({ has: page.getByRole('heading', { name: row.title, exact: true }) }).getByRole('button').count(), 0);
      }
    });
    await scenario('mobile directory/workspace fit 320px and long organization text stays escaped', async () => {
      const longName = 'Long <img src=x onerror=alert(1)> organization ' + 'W'.repeat(70);
      await pool.query('UPDATE organizers SET name=$2 WHERE id=$1', [organization.id, longName]);
      await page.setViewportSize({ width: 320, height: 850 });
      for (const url of [`${config.PUBLIC_ORIGIN}/organizers`, eventsUrl()]) {
        await page.goto(url); await expect(page.getByRole('button', { name: 'Refresh workspace' })).toBeEnabled();
        await expect(page.getByText(longName, { exact: true })).toBeVisible();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('main img').count(), 0);
        await visual(page, url === eventsUrl() ? 'mobile-events' : 'mobile-organizations');
      }
    });
    await scenario('expired session during a save clears private data and returns to sign-in', async () => {
      await page.getByLabel('Event title').fill('Expired session write'); await page.getByLabel('Category', { exact: true }).fill('Talks');
      await pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL", [owner]);
      await page.getByRole('button', { name: 'Save new draft' }).click(); await expect(page).toHaveURL(/\/sign-in$/);
      assert.equal(await eventCount('Expired session write'), 0); assert.equal(await page.locator('.event-list').count(), 0);
    });
    assert.deepEqual(pageErrors, []);
    console.log(`Organizer browser verified: ${browser.version()}; built assets, loopback HTTP, private PostgreSQL schema.`);
  } finally {
    await context?.close(); await browser?.close();
    if (web) await new Promise(resolve => web.httpServer.close(resolve));
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await pool?.end();
    if (admin) {
      await admin.query('ROLLBACK');
      if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      admin.release();
    }
    await adminPool.end();
  }
});
