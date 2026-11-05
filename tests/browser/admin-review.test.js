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

// Local acceptance source. No external origin is needed. This was not executed
// by the agent after the earlier browser-path approval rejection.
test('administrator review desk (built UI + real API + PostgreSQL)', { timeout: 120000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL);
  let db, schema, pool, api, web, browser, administrator, organization;
  const contexts = [], pageErrors = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '' };
  const organizationName = 'Small Stage <img src=x onerror=alert(1)>';
  async function scenario(name, work) {
    let failure;
    await t.test(name, async () => { try { await work(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
  }
  async function actor(role) {
    const user = (await pool.query("INSERT INTO users(email,display_name,password_hash,system_role) VALUES($1,'Review fixture','fixture-only-not-a-real-password-hash',$2) RETURNING id", [`${randomUUID()}@example.invalid`, role])).rows[0];
    const raw = newToken();
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [user.id, digest(raw), digest(csrfFor(raw, config.AUTH_SECRET))]);
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } }); contexts.push(context);
    await context.route('**/*', route => new URL(route.request().url()).origin === config.PUBLIC_ORIGIN ? route.continue() : route.abort('blockedbyclient'));
    await context.addCookies([{ name: 'seatledger_session', value: raw, url: config.PUBLIC_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    return { ...user, page };
  }
  const current = async () => (await pool.query('SELECT status,status_version FROM organizers WHERE id=$1', [organization.id])).rows[0];
  const listItem = page => page.locator('.review-list>li').filter({ has: page.getByRole('heading', { name: organizationName, exact: true }) });
  try {
    db = await adminPool.connect(); await db.query('BEGIN'); schema = await installReliabilitySchema(db, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql']) await db.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await db.query('COMMIT');
    const connection = new URL(readDatabaseConfig().DATABASE_URL); connection.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(connection.toString());
    api = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { api.once('listening', resolve); api.once('error', reject); });
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
    config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
    const customer = await actor('CUSTOMER'); administrator = await actor('ADMIN');
    organization = (await pool.query('INSERT INTO organizers(name) VALUES($1) RETURNING id', [organizationName])).rows[0];
    await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'OWNER')", [organization.id, customer.id]);
    const { page } = administrator;
    await scenario('customers cannot open the review desk and admins reach it from their account', async () => {
      await customer.page.goto(`${config.PUBLIC_ORIGIN}/account`);
      assert.equal(await customer.page.getByRole('link', { name: 'Review organizations' }).count(), 0);
      await customer.page.goto(`${config.PUBLIC_ORIGIN}/admin/organizers`);
      await expect(customer.page.getByRole('heading', { name: 'A restricted review desk.' })).toBeVisible();
      assert.equal(await customer.page.locator('.review-list').count(), 0);
      await page.goto(`${config.PUBLIC_ORIGIN}/account`); await page.getByRole('link', { name: 'Review organizations' }).click();
      await expect(page.getByRole('heading', { name: organizationName, exact: true })).toBeVisible();
      assert.equal(await page.locator('main img').count(), 0);
    });
    await scenario('review confirmation can be cancelled without sending a decision', async () => {
      let posts = 0;
      const count = request => { if (request.method() === 'POST' && request.url().endsWith('/status')) posts++; };
      page.on('request', count);
      const button = listItem(page).getByRole('button', { name: /^Approve organization/ });
      await button.click(); await expect(page.getByRole('heading', { name: 'Open event access?' })).toBeFocused();
      await page.getByRole('button', { name: 'Keep current status' }).click(); await expect(button).toBeFocused();
      assert.equal(posts, 0); page.off('request', count); assert.deepEqual(await current(), { status: 'PENDING', status_version: 0 });
    });
    await scenario('double-confirmed approval commits once with exact version and removes the pending row', async () => {
      await listItem(page).getByRole('button', { name: /^Approve organization/ }).click();
      const request = page.waitForRequest(value => value.method() === 'POST' && value.url().endsWith('/status'));
      await page.getByRole('button', { name: 'Confirm approval', exact: true }).evaluate(button => { button.click(); button.click(); });
      assert.deepEqual((await request).postDataJSON(), { status: 'APPROVED', expectedVersion: 0 });
      await expect(page.getByText('Organization approved. Existing active members can now access events.', { exact: true })).toBeVisible();
      await expect(listItem(page)).toHaveCount(0); assert.deepEqual(await current(), { status: 'APPROVED', status_version: 1 });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='organizer.approved'", [organization.id])).rows[0].n, 1);
    });
    await scenario('filtered approved/suspended views support suspension and reapproval with clear effects', async () => {
      await page.getByRole('link', { name: 'Approved', exact: true }).click();
      await listItem(page).getByRole('button', { name: /^Suspend organization/ }).click();
      await expect(page.getByText('Existing members will lose access to the event workspace. This does not cancel shows or bookings, or issue refunds.', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Confirm suspension' }).click(); await expect(listItem(page)).toHaveCount(0);
      assert.deepEqual(await current(), { status: 'SUSPENDED', status_version: 2 });
      await page.getByRole('link', { name: 'Suspended', exact: true }).click();
      await listItem(page).getByRole('button', { name: /^Reapprove organization/ }).click(); await page.getByRole('button', { name: 'Confirm approval' }).click();
      await expect(listItem(page)).toHaveCount(0); assert.deepEqual(await current(), { status: 'APPROVED', status_version: 3 });
    });
    await scenario('an approval/suspension round trip after review invalidates the old confirmation', async () => {
      await page.getByRole('link', { name: 'Approved', exact: true }).click(); await listItem(page).getByRole('button', { name: /^Suspend organization/ }).click();
      await pool.query("UPDATE organizers SET status='SUSPENDED' WHERE id=$1", [organization.id]);
      await pool.query("UPDATE organizers SET status='APPROVED' WHERE id=$1", [organization.id]);
      await page.getByRole('button', { name: 'Confirm suspension' }).click();
      await expect(page.getByRole('alert')).toHaveText('Another decision changed this organization. Reload the review list before deciding again.');
      assert.deepEqual(await current(), { status: 'APPROVED', status_version: 5 }); assert.equal(await page.getByRole('button', { name: 'Confirm suspension' }).count(), 0);
      await page.getByRole('button', { name: 'Reload workspace', exact: true }).click(); await expect(listItem(page)).toHaveCount(1);
    });
    await scenario('demotion after rendering is denied by the server and session recovery closes the desk', async () => {
      await listItem(page).getByRole('button', { name: /^Suspend organization/ }).click();
      await pool.query("UPDATE users SET system_role='CUSTOMER' WHERE id=$1", [administrator.id]);
      await page.getByRole('button', { name: 'Confirm suspension' }).click();
      await expect(page.getByRole('alert')).toHaveText('Administrator access is required to review organizations.');
      assert.equal((await current()).status_version, 5);
      await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'A restricted review desk.' })).toBeVisible();
      await pool.query("UPDATE users SET system_role='ADMIN' WHERE id=$1", [administrator.id]);
      await page.reload(); await expect(listItem(page)).toHaveCount(1);
    });
    await scenario('a lost committed-decision response is reconciled by GET without repeating POST', async () => {
      let posts = 0; const pattern = `**/api/admin/organizers/${organization.id}/status`;
      await page.route(pattern, async route => { posts++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); });
      await listItem(page).getByRole('button', { name: /^Suspend organization/ }).click(); await page.getByRole('button', { name: 'Confirm suspension' }).click();
      await expect(page.getByRole('alert')).toContainText('may already be recorded'); assert.equal(posts, 1);
      assert.deepEqual(await current(), { status: 'SUSPENDED', status_version: 6 });
      await page.unroute(pattern); await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
      await expect(listItem(page)).toHaveCount(0); await page.getByRole('link', { name: 'Suspended', exact: true }).click();
      await expect(listItem(page)).toHaveCount(1); assert.equal(posts, 1);
    });
    await scenario('review pages are bounded, keyboard-navigable and fit a narrow viewport', async () => {
      for (let i = 0; i < 21; i++) await pool.query('INSERT INTO organizers(name) VALUES($1)', [`Review queue ${i}`]);
      await page.getByRole('link', { name: 'Awaiting review', exact: true }).click(); await expect(page.locator('.review-list>li')).toHaveCount(20);
      await page.getByRole('button', { name: 'Next page' }).click(); await expect(page.locator('.review-list>li')).toHaveCount(2);
      await page.getByRole('button', { name: 'First page' }).click(); await expect(page.locator('.review-list>li')).toHaveCount(20);
      await page.setViewportSize({ width: 320, height: 850 }); await page.getByRole('link', { name: 'Suspended', exact: true }).click();
      await expect(listItem(page)).toHaveCount(1); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await listItem(page).getByRole('button', { name: /^Reapprove organization/ }).click();
      await expect(page.getByRole('heading', { name: 'Open event access?' })).toBeFocused();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
    await scenario('expiry during confirmation returns to sign-in without changing the organization', async () => {
      await pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL", [administrator.id]);
      await page.getByRole('button', { name: 'Confirm approval' }).click(); await expect(page).toHaveURL(/\/sign-in$/);
      assert.deepEqual(await current(), { status: 'SUSPENDED', status_version: 6 });
    });
    assert.deepEqual(pageErrors, []); console.log(`Admin review browser verified: ${browser.version()}; local HTTP/private PostgreSQL.`);
  } finally {
    for (const context of contexts) await context.close(); await browser?.close();
    if (web) await new Promise(resolve => web.httpServer.close(resolve));
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await pool?.end();
    if (db) { await db.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await db.query(`DROP SCHEMA "${schema}" CASCADE`); } db.release(); }
    await adminPool.end();
  }
});
