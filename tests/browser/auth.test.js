import { test } from 'node:test';
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

test('customer account screens (built React + browser + API + PostgreSQL)', { timeout: 120000 }, async t => {
  const adminPool = createPool(readDatabaseConfig().DATABASE_URL);
  let admin, pool, schema, api, web, browser;
  const contexts = [], pageErrors = [];
  const password = 'A memorable local passphrase 2026!';
  const email = `${randomUUID()}@example.invalid`;
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '' };
  async function visual(page, name) {
    if (process.env.SEATLEDGER_VISUAL_CHECK !== 'true') return;
    await mkdir(new URL('../../test-results/auth-visual/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`../../test-results/auth-visual/${name}.png`, import.meta.url)), fullPage: true });
  }
  async function pageFor(viewport = { width: 1366, height: 1000 }) {
    const context = await browser.newContext({ viewport }); contexts.push(context);
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    return page;
  }
  async function scenario(name, work) {
    let failure;
    await t.test(name, async () => {
      try { await work(); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  async function login(page) {
    await page.goto(`${config.PUBLIC_ORIGIN}/sign-in`);
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
  }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN');
    schema = await installReliabilitySchema(admin, 'auth_test');
    await admin.query(await readFile(new URL('../../db/migrations/006_auth_throttling.sql', import.meta.url), 'utf8'));
    await admin.query('COMMIT');
    const connection = new URL(readDatabaseConfig().DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema},public`);
    pool = createPool(connection.toString());
    api = createApp({ pool, config, authLimits: { loginIp: 1000, loginEmail: 1000, registerIp: 1000 }, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { api.once('listening', resolve); api.once('error', reject); });
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
    config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {});
    const page = await pageFor();

    await scenario('a cold session endpoint explains startup and recovers automatically without submitting credentials', async () => {
      let reads = 0, writes = 0;
      const count = request => { if (request.method() === 'POST') writes++; };
      page.on('request', count);
      await page.route('**/api/auth/session', route => ++reads === 1
        ? route.fulfill({ status: 503, contentType: 'text/html', body: 'Starting' }) : route.continue());
      await page.goto(`${config.PUBLIC_ORIGIN}/sign-in`);
      await expect(page.getByRole('status')).toContainText('starting up');
      await expect(page.getByLabel('Email address', { exact: true })).toBeVisible({ timeout: 10000 });
      assert.equal(reads, 2); assert.equal(writes, 0);
      await page.unroute('**/api/auth/session'); page.off('request', count);
    });

    await scenario('anonymous account redirect, shared field validation and keyboard-friendly labels', async () => {
      await page.goto(`${config.PUBLIC_ORIGIN}/account`);
      await expect(page).toHaveURL(/\/sign-in$/);
      await page.getByRole('link', { name: 'Create an account', exact: true }).click();
      await visual(page, 'desktop-sign-up');
      await page.getByLabel('Your name', { exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(page.getByLabel('Email address', { exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(page.getByLabel('Your name', { exact: true })).toBeFocused();
      await expect(page.getByText('Enter a name between 1 and 120 characters.')).toBeVisible();
      await page.getByLabel('Your name', { exact: true }).fill('Mira Rao');
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill('too short');
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
      await expect(page.getByText('Use 15–128 characters and no more than 256 UTF-8 bytes.')).toBeVisible();
    });
    await scenario('registration commits once, double submission is blocked, browser cookie stays HttpOnly', async () => {
      let requests = 0;
      const count = request => { if (request.url().endsWith('/api/auth/register') && request.method() === 'POST') requests++; };
      page.on('request', count);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Show password', exact: true }).click();
      await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
      await page.getByRole('button', { name: 'Hide password', exact: true }).click();
      await page.getByRole('button', { name: 'Create account', exact: true }).evaluate(button => { button.click(); button.click(); });
      await expect(page).toHaveURL(/\/account$/);
      await expect(page.getByText('Mira Rao', { exact: true })).toBeVisible();
      await visual(page, 'desktop-account');
      assert.equal(requests, 1); page.off('request', count);
      const cookies = await page.context().cookies(); const sessionCookie = cookies.find(value => value.name === 'seatledger_session');
      assert.equal(sessionCookie?.httpOnly, true); assert.equal(sessionCookie.sameSite, 'Lax');
      assert.equal(await page.evaluate(() => document.cookie.includes('seatledger_session')), false);
      assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE email=$1', [email])).rows[0].n, 1);
    });
    await scenario('deep reload restores the account and protected guest routes redirect', async () => {
      await page.reload(); await expect(page.getByText('Mira Rao', { exact: true })).toBeVisible();
      await page.goto(`${config.PUBLIC_ORIGIN}/sign-up`); await expect(page).toHaveURL(/\/account$/);
      await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
    });
    await scenario('real CSRF rejection keeps the DB session active and requires explicit recovery', async () => {
      await page.route('**/api/auth/logout', route => route.continue({ headers: { ...route.request().headers(), 'x-csrf-token': 'b'.repeat(43) } }));
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Let’s reconnect.' })).toBeVisible();
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n, 1);
      await page.unroute('**/api/auth/logout');
      await page.getByRole('button', { name: 'Check session' }).click();
      await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
    });
    let other;
    await scenario('two devices sign in; current logout keeps the other session; wrong login and duplicate signup are explained', async () => {
      other = await pageFor(); await login(other);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByText('You have signed out.', { exact: true })).toBeVisible();
      await other.reload(); await expect(other.getByRole('heading', { name: 'Your details' })).toBeVisible();
      await page.bringToFront();
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill('An incorrect test password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect. Please try again.');
      await expect(page.getByRole('alert')).toBeFocused();
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
      await page.getByRole('link', { name: 'Create an account', exact: true }).click();
      await page.getByLabel('Your name', { exact: true }).fill('Mira Rao');
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('already exists');
      await login(page);
    });
    await scenario('logout-all confirmation can be cancelled, then revokes both browser sessions', async () => {
      await page.getByRole('button', { name: 'Sign out on all devices', exact: true }).click();
      await page.getByRole('button', { name: 'Keep sessions', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out on all devices', exact: true }).click();
      await page.getByRole('button', { name: 'Yes, sign out everywhere', exact: true }).click();
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByText('Signed out on all devices.', { exact: true })).toBeVisible();
      await other.reload(); await expect(other).toHaveURL(/\/sign-in$/);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n, 0);
    });
    await scenario('a DB-expired session is recognized on browser focus', async () => {
      await login(page);
      await pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '8 days', expires_at=clock_timestamp()-interval '1 second' WHERE revoked_at IS NULL");
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByText('Your session has ended. Please sign in again.', { exact: true })).toBeVisible();
    });
    await scenario('network failure during bootstrap shows unknown state and reconnect restores the real session', async () => {
      await login(page);
      await page.route('**/api/auth/session', route => route.abort('failed'));
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Let’s reconnect.' })).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('sign-in status is unknown');
      await page.unroute('**/api/auth/session');
      await page.getByRole('button', { name: 'Check session' }).click();
      await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
    });
    await scenario('a dropped response after logout commits is reconciled by GET, without replaying POST', async () => {
      let mutations = 0;
      await page.route('**/api/auth/logout', async route => {
        mutations++; const response = await route.fetch(); assert.equal(response.status(), 204); await route.abort('failed');
      });
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Let’s reconnect.' })).toBeVisible();
      await page.unroute('**/api/auth/logout');
      await page.getByRole('button', { name: 'Check session' }).click();
      await expect(page).toHaveURL(/\/sign-in$/); assert.equal(mutations, 1);
    });
    await scenario('rate-limit retry guidance and hostile response text stay safe (injected response)', async () => {
      await page.route('**/api/auth/login', route => route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '42' }, body: JSON.stringify({ error: 'AUTH_RATE_LIMITED', detail: '<img src=x onerror=alert(1)>' }) }));
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Too many attempts. Try again in 42 seconds.');
      assert.equal(await page.locator('main img').count(), 0);
      await page.unroute('**/api/auth/login');
    });
    await scenario('mobile screens fit 320px, account content is escaped, and unknown routes recover', async () => {
      const mobile = await pageFor({ width: 320, height: 850 });
      for (const path of ['/', '/sign-up', '/sign-in', '/a-missing-page']) {
        await mobile.goto(`${config.PUBLIC_ORIGIN}${path}`);
        await expect(mobile.locator('h1')).toBeVisible();
        if (path === '/sign-up') await visual(mobile, 'mobile-sign-up');
        assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, path);
      }
      await pool.query('UPDATE users SET display_name=$1 WHERE email=$2', ['Reader <img src=x onerror=alert(1)>', email]);
      await login(mobile);
      await expect(mobile.getByText('Reader <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
      assert.equal(await mobile.locator('main img').count(), 0);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mobile.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(mobile).toHaveURL(/\/sign-in$/);
    });
    assert.deepEqual(pageErrors, []);
    console.log(`Browser verified: ${browser.version()}; built assets, loopback HTTP, isolated PostgreSQL.`);
  } finally {
    for (const context of contexts) await context.close();
    await browser?.close();
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

