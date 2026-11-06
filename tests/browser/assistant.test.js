import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { evidenceFixture } from '../../scripts/lib/evidence-fixture.js';
import { bookingModel } from '../helpers/assistant-model.js';
import { runPaymentBatch } from '../../apps/api/src/payments/worker.js';
import { runDeliveryBatch } from '../../apps/api/src/payments/delivery.js';
import { runInboxBatch } from '../../apps/api/src/payments/processor.js';

test('AI assistant built UI uses mocked model and real booking, payment and ticket services', { timeout: 120000 }, async t => {
  await evidenceFixture(async c => {
    let web, browser; const contexts = [], errors = [], external = [];
    const counts = async () => (await c.pool.query('SELECT (SELECT count(*)::int FROM reservations) AS holds,(SELECT count(*)::int FROM payment_attempts) AS payments')).rows[0];
    async function customer(width = 1280) {
      const who = await c.actor(), context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } }); contexts.push(context);
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === c.config.PUBLIC_ORIGIN) return route.continue();
        external.push(route.request().url()); return route.abort('blockedbyclient');
      });
      await context.addCookies([{ name: 'seatledger_session', value: who.token, url: c.config.PUBLIC_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); return { ...who, page, context };
    }
    async function prepare(who) {
      const page = who.page; await page.goto(c.config.PUBLIC_ORIGIN + '/assistant');
      await expect(page.getByLabel('What would you like to see?')).toBeEnabled();
      await page.getByLabel('What would you like to see?').fill('Find comedy in Bangalore, two seats under ₹1500 total');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('button', { name: 'Check seats for event 1', exact: true }).click();
      await page.getByRole('button', { name: 'Review seat option 1', exact: true }).click();
      await expect(page.getByRole('button', { name: /^Confirm hold/ })).toBeEnabled();
    }
    async function scenario(name, work) {
      let failure; await t.test(name, async () => { try { await work(); } catch (error) { failure = error; throw error; } }); if (failure) throw failure;
    }
    try {
      const f = await c.catalogue('Comedy at the local stage'); await c.addSeats(f, 8);
      await c.pool.query("UPDATE venues SET city='Bengaluru' WHERE id=$1", [f.venue]);
      await c.pool.query("UPDATE events SET category='Comedy' WHERE id=$1", [f.event]);
      web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error',
        preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': c.origins[0] } } });
      c.config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
      browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}),
        args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
      await scenario('search cards, adjacent seats, explicit hold, existing checkout and QR tickets', async () => {
        const who = await customer(), page = who.page; await prepare(who);
        assert.deepEqual(await counts(), { holds: 0, payments: 0 });
        await expect(page.getByRole('region', { name: 'Booking summary' })).toContainText('₹1,500.00');
        await expect(page.getByRole('list', { name: 'Booking steps' }).locator('[aria-current="step"]')).toContainText('Review & hold');
        await mkdir(new URL('../../test-results/assistant/', import.meta.url), { recursive: true });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: fileURLToPath(new URL('../../test-results/assistant/desktop.png', import.meta.url)), fullPage: true });
        await page.getByRole('button', { name: /^Confirm hold/ }).dblclick();
        await expect(page.getByRole('link', { name: 'Review & start simulated payment', exact: true })).toBeVisible();
        await expect(page.getByText(/Time remaining:/)).toBeVisible(); assert.deepEqual(await counts(), { holds: 1, payments: 0 });
        await page.reload(); await expect(page.getByRole('link', { name: 'Review & start simulated payment', exact: true })).toBeVisible();
        await page.getByRole('link', { name: 'Review & start simulated payment', exact: true }).click();
        await page.getByRole('button', { name: 'Start simulated payment', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Your payment is processing.', exact: true })).toBeVisible();
        assert.equal((await runPaymentBatch(c.pool, { workerId: 'assistant-browser', scenario: 'success' })).completed, 1);
        await c.pool.query('SELECT pg_sleep(.25)');
        assert.equal((await runDeliveryBatch(c.pool, { workerId: 'assistant-browser-delivery', callbackUrl: c.origins[0] + '/api/payments/simulated/events', secret: c.config.SIMULATOR_WEBHOOK_SECRET })).failed, 0);
        assert.equal((await runInboxBatch(c.pool)).failed, 0);
        await page.getByRole('button', { name: 'Check status', exact: true }).click();
        await page.getByRole('link', { name: 'View saved booking receipt', exact: true }).click();
        await page.getByRole('button', { name: 'Issue or recover tickets', exact: true }).click();
        const qrButtons = page.getByRole('button', { name: 'Show private QR & admission code', exact: true });
        await expect(qrButtons).toHaveCount(2); await qrButtons.first().click(); await qrButtons.first().click();
        await expect(page.getByRole('img', { name: 'Private admission QR code', exact: true })).toHaveCount(2);
        await page.goto(c.config.PUBLIC_ORIGIN + '/assistant');
        await expect(page.getByRole('link', { name: 'View saved booking receipt', exact: true })).toBeVisible();
        assert.deepEqual(await counts(), { holds: 1, payments: 1 });
      });
      await scenario('lost confirmation acknowledgement recovers by read without another POST', async () => {
        const who = await customer(390), page = who.page; await prepare(who); let posts = 0;
        await page.route('**/api/assistant/conversations/*/confirm-hold', async route => {
          posts++; const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed');
        });
        await page.getByRole('button', { name: /^Confirm hold/ }).click();
        await expect(page.getByRole('alert')).toContainText('response could not be confirmed');
        await page.getByRole('button', { name: 'Check saved outcome', exact: true }).click();
        await expect(page.getByRole('link', { name: 'Review & start simulated payment', exact: true })).toBeVisible();
        assert.equal(posts, 1); assert.deepEqual(await counts(), { holds: 2, payments: 1 });
        await page.unroute('**/api/assistant/conversations/*/confirm-hold');
        await page.setViewportSize({ width: 320, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow at 320px');
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: fileURLToPath(new URL('../../test-results/assistant/mobile.png', import.meta.url)), fullPage: true });
        await page.goto(c.config.PUBLIC_ORIGIN + '/account'); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await page.goto(c.config.PUBLIC_ORIGIN + '/assistant');
        await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
        await expect(page.getByText('Comedy at the local stage', { exact: true })).toHaveCount(0);
      });
      await scenario('starter prompts are editable, keyboard sends once, and past cards collapse', async () => {
        const who = await customer(), page = who.page; let posts = 0;
        page.on('request', request => { if (request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname)) posts++; });
        await page.goto(c.config.PUBLIC_ORIGIN + '/assistant');
        const composer = page.getByLabel('What would you like to see?');
        await expect(page.getByRole('button', { name: 'Comedy in Bengaluru', exact: true })).toBeVisible();
        await expect(composer).toBeInViewport();
        await page.screenshot({ path: fileURLToPath(new URL('../../test-results/assistant/desktop-start.png', import.meta.url)), fullPage: true });
        await page.getByRole('button', { name: 'Comedy in Bengaluru', exact: true }).click();
        await expect(composer).toHaveValue(/two adjacent seats under ₹1,500 total/); assert.equal(posts, 0, 'A starter must not submit or spend quota');
        await composer.press('End'); await composer.press('Shift+Enter'); await composer.press('Enter');
        await expect(page.getByRole('button', { name: 'Check seats for event 1', exact: true })).toBeVisible(); assert.equal(posts, 1);
        await expect(page.getByRole('complementary', { name: 'Booking details' })).toContainText('Your current search');
        await page.getByRole('button', { name: 'Check seats for event 1', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Review seat option 1', exact: true })).toBeVisible();
        const history = page.locator('details.assistant-history').first(); await expect(history).not.toHaveAttribute('open');
        await history.locator('summary').click(); await expect(history).toHaveAttribute('open', '');
        await expect(history.getByRole('button')).toHaveCount(0); await history.locator('summary').click();
        await page.getByRole('button', { name: 'Cheaper options', exact: true }).click();
        await expect(composer).toHaveValue(/Show cheaper options/); assert.equal(posts, 2);
        for (const width of [320,390,768,820,1024,1280]) {
          await page.setViewportSize({ width, height: 900 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px`);
          assert.ok(await page.locator('.assistant-messages').evaluate(element => element.scrollWidth <= element.clientWidth), `No chat overflow at ${width}px`);
        }
        await page.setViewportSize({ width: 390, height: 900 });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: fileURLToPath(new URL('../../test-results/assistant/mobile-seats.png', import.meta.url)), fullPage: true });
      });
      await scenario('expired summaries offer fresh seats and cannot present a confirmation action', async () => {
        const who = await customer(390), page = who.page; await prepare(who);
        const before = await counts();
        await c.pool.query("UPDATE assistant_conversations SET context=jsonb_set(context,'{proposal,expiresAt}',$2::jsonb) WHERE user_id=$1", [who.id, JSON.stringify(new Date(Date.now() - 60000).toISOString())]);
        await page.reload();
        await expect(page.getByRole('region', { name: 'Booking summary' })).toContainText('Summary expired');
        await expect(page.getByRole('button', { name: /^Confirm hold/ })).toHaveCount(0);
        await page.getByRole('button', { name: 'Find fresh seats', exact: true }).click();
        await expect(page.getByLabel('What would you like to see?')).toHaveValue('Recommend seats again for the same event.');
        assert.deepEqual(await counts(), before);
      });
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { for (const context of contexts) await context.close(); await browser?.close(); await web?.close(); }
  }, { assistantModel: bookingModel(), assistantConfig: { AI_ASSISTANT_ENABLED: true } });
});
