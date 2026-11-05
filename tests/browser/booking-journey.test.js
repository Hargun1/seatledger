import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { evidenceFixture } from '../../scripts/lib/evidence-fixture.js';
import { runPaymentBatch } from '../../apps/api/src/payments/worker.js';
import { runDeliveryBatch } from '../../apps/api/src/payments/delivery.js';
import { runInboxBatch } from '../../apps/api/src/payments/processor.js';

// Real built UI -> authenticated HTTP -> PostgreSQL -> signed simulator HTTP.
// SQL creates catalogue/sessions only; no SQL-funded successful booking fixture.
test('complete customer booking and recovery in the built browser', { timeout: 120000 }, async t => {
  await evidenceFixture(async c => {
    let web, browser; const contexts = [], errors = [], external = [];
    const path = f => `/events/${f.event}/shows/${f.show}`;
    const seat = page => page.getByRole('button', { name: /^Stalls, row A, seat 1:/ });
    const paymentRows = async f => (await c.pool.query('SELECT * FROM payment_attempts WHERE show_id=$1', [f.show])).rows;
    async function customer() {
      const who = await c.actor();
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } }); contexts.push(context);
      await context.route('**/*', route => {
        const origin = new URL(route.request().url()).origin;
        if (origin === c.config.PUBLIC_ORIGIN) return route.continue();
        external.push(origin); return route.abort('blockedbyclient');
      });
      await context.addCookies([{ name: 'seatledger_session', value: who.token, url: c.config.PUBLIC_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      return { ...who, page, context };
    }
    async function reserve(who, f) {
      await who.page.goto(c.config.PUBLIC_ORIGIN + path(f) + '/reserve');
      await expect(seat(who.page)).toBeEnabled(); await seat(who.page).click();
      await who.page.getByRole('button', { name: 'Hold selected seats', exact: true }).click();
      await expect(who.page.getByRole('link', { name: 'Review & start simulated payment', exact: true })).toBeVisible();
    }
    async function checkout(who) {
      await who.page.getByRole('link', { name: 'Review & start simulated payment', exact: true }).click();
      await expect(who.page.getByRole('button', { name: 'Start simulated payment', exact: true })).toBeEnabled();
    }
    async function settle(scenario = 'success') {
      const created = await runPaymentBatch(c.pool, { workerId: 'browser-journey', batchSize: 10, scenario });
      assert.equal(created.failed, 0); assert.equal(created.completed, 1);
      // Wait on the simulator's actual due time, not an invented browser outcome.
      await c.pool.query('SELECT pg_sleep(0.25)');
      const delivered = await runDeliveryBatch(c.pool, { callbackUrl: c.origins[0] + '/api/payments/simulated/events',
        secret: c.config.SIMULATOR_WEBHOOK_SECRET, workerId: 'browser-delivery', batchSize: 10 });
      assert.equal(delivered.failed, 0); assert.equal(delivered.delivered, scenario === 'duplicate' ? 3 : 2);
      const processed = await runInboxBatch(c.pool); assert.equal(processed.failed, 0);
    }
    async function scenario(name, work) {
      let failure; await t.test(name, async () => { try { await work(); } catch (error) { failure = error; throw error; } });
      if (failure) throw failure;
    }
    try {
      web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error',
        preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': c.origins[0] } } });
      c.config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
      browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}),
        args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });

      await scenario('discover, reserve, reload processing, signed duplicate callbacks, receipt, ticket and private print', async () => {
        const f = await c.catalogue(), who = await customer(), page = who.page;
        await page.goto(c.config.PUBLIC_ORIGIN + '/events');
        await page.getByLabel('Search the bill').fill(f.title); await page.getByRole('button', { name: /Find events/ }).click();
        await page.getByRole('link', { name: new RegExp(f.title) }).click();
        await page.getByRole('link', { name: /^View seating/ }).click();
        await page.getByRole('link', { name: 'Choose seats & hold', exact: true }).click();
        await expect(seat(page)).toBeEnabled(); await seat(page).focus(); await page.keyboard.press('Space');
        await expect(seat(page)).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Hold selected seats', exact: true }).click(); await checkout(who);
        await page.getByRole('button', { name: 'Start simulated payment', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Your payment is processing.', exact: true })).toBeVisible();
        await page.reload(); await expect(page.getByRole('heading', { name: 'Your payment is processing.', exact: true })).toBeVisible();
        assert.equal((await paymentRows(f)).length, 1); await settle('duplicate');
        await page.getByRole('button', { name: 'Check status', exact: true }).click();
        await page.getByRole('link', { name: 'View saved booking receipt', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Your booking.', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Issue or recover tickets', exact: true }).click();
        await page.getByRole('button', { name: 'Show private QR & admission code', exact: true }).click();
        await expect(page.getByRole('img', { name: 'Private admission QR code', exact: true })).toHaveCount(1);
        await page.getByRole('link', { name: 'Open private printable tickets', exact: true }).click();
        await expect(page.locator('.print-ticket')).toHaveCount(1);
        const counts = (await c.pool.query(`SELECT
          (SELECT count(*)::int FROM bookings WHERE show_id=$1) AS bookings,
          (SELECT count(*)::int FROM admission_tickets a JOIN bookings b ON b.id=a.booking_id WHERE b.show_id=$1) AS tickets,
          (SELECT count(*)::int FROM show_seats WHERE show_id=$1 AND state='BOOKED') AS booked`, [f.show])).rows[0];
        assert.deepEqual(counts, { bookings: 1, tickets: 1, booked: 1 });
      });

      await scenario('two stale seat selections produce one hold; loser refreshes and recovers after release', async () => {
        const f = await c.catalogue(), a = await customer(), b = await customer();
        for (const who of [a, b]) { await who.page.goto(c.config.PUBLIC_ORIGIN + path(f) + '/reserve'); await expect(seat(who.page)).toBeEnabled(); }
        // Select AFTER both pages are open: focus refreshes cannot change this into an owned-seat click.
        await b.page.bringToFront(); await expect(seat(b.page)).toBeEnabled(); await seat(b.page).click();
        await seat(a.page).evaluate(button => button.click());
        await a.page.getByRole('button', { name: 'Hold selected seats', exact: true }).evaluate(button => button.click());
        await expect(a.page.getByRole('link', { name: 'Review & start simulated payment', exact: true })).toBeVisible();
        await b.page.getByRole('button', { name: 'Hold selected seats', exact: true }).click();
        await expect(b.page.getByText('Some chosen seats are no longer available. Check the current availability.', { exact: true })).toBeVisible();
        assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM reservations WHERE show_id=$1', [f.show])).rows[0].n, 1);
        await a.page.getByRole('button', { name: 'Release this hold', exact: true }).click();
        await a.page.getByRole('button', { name: 'Yes, release seats', exact: true }).click();
        await expect(a.page.getByRole('link', { name: 'Review & start simulated payment', exact: true })).toHaveCount(0);
        await b.page.getByRole('button', { name: 'Refresh seats & holds', exact: true }).click();
        await expect(seat(b.page)).toBeEnabled();
        if (await seat(b.page).getAttribute('aria-pressed') !== 'true') await seat(b.page).click();
        await b.page.getByRole('button', { name: 'Hold selected seats', exact: true }).click();
        await expect(b.page.getByRole('link', { name: 'Review & start simulated payment', exact: true })).toBeVisible();
      });

      await scenario('expired agreement cannot start payment; worker-off inventory can be held again', async () => {
        const f = await c.catalogue(), who = await customer();
        // Historical five-minute agreement, already expired at setup. Never edit immutable deadlines.
        const old = await c.tx(async db => {
          const r = (await db.query(`WITH n AS MATERIALIZED(SELECT clock_timestamp()-interval '6 minutes' AS at)
            INSERT INTO reservations(user_id,show_id,total_minor,currency,created_at,expires_at)
            SELECT $1,$2,75000,'INR',at,at+interval '5 minutes' FROM n RETURNING id`, [who.id, f.show])).rows[0];
          await db.query("INSERT INTO reservation_items(reservation_id,show_id,venue_seat_id,price_minor,currency) VALUES($1,$2,$3,75000,'INR')", [r.id, f.show, f.seat]);
          await db.query('UPDATE reservations SET sealed_at=clock_timestamp() WHERE id=$1', [r.id]);
          await db.query("UPDATE show_seats s SET state='HELD',reservation_id=r.id,expires_at=r.expires_at FROM reservations r WHERE r.id=$1 AND s.show_id=$2", [r.id, f.show]);
          return r;
        });
        await who.page.goto(c.config.PUBLIC_ORIGIN + path(f) + '/checkout/' + old.id);
        await expect(who.page.getByText('This hold is expired', { exact: false })).toBeVisible();
        await expect(who.page.getByRole('button', { name: 'Start simulated payment', exact: true })).toBeDisabled();
        assert.equal((await paymentRows(f)).length, 0); await reserve(who, f);
        assert.notEqual((await c.pool.query('SELECT reservation_id FROM show_seats WHERE show_id=$1', [f.show])).rows[0].reservation_id, old.id);
      });

      await scenario('failed signed payment stays visible after reload without creating tickets or another payment', async () => {
        const f = await c.catalogue(), who = await customer(); await reserve(who, f); await checkout(who);
        await who.page.getByRole('button', { name: 'Start simulated payment', exact: true }).click();
        await expect(who.page.getByRole('heading', { name: 'Your payment is processing.', exact: true })).toBeVisible();
        await settle('failure'); await who.page.reload();
        await expect(who.page.getByRole('heading', { name: 'The simulated payment failed.', exact: true })).toBeVisible();
        await expect(who.page.getByRole('button', { name: 'Payment already started', exact: true })).toBeDisabled();
        assert.equal((await paymentRows(f)).length, 1);
        assert.equal((await c.pool.query('SELECT count(*)::int AS n FROM bookings WHERE show_id=$1', [f.show])).rows[0].n, 0);
      });

      await scenario('lost committed payment acknowledgement reloads GET-only then retries the original key once', async () => {
        const f = await c.catalogue(), who = await customer(), keys = []; await reserve(who, f); await checkout(who);
        const pattern = '**/api/reservations/*/payment-attempts'; let lose = true;
        let retryFulfilled;
        const retryResponse = new Promise(resolve => { retryFulfilled = resolve; });
        await who.page.route(pattern, async route => {
          if (route.request().method() !== 'POST') return route.continue();
          keys.push(route.request().headers()['idempotency-key']);
          const response = await route.fetch(); assert.equal(response.status(), 201);
          if (lose) { lose = false; await route.abort('failed'); }
          else { await route.fulfill({ response }); retryFulfilled(); }
        });
        await who.page.getByRole('button', { name: 'Start simulated payment', exact: true }).click();
        await expect(who.page.getByRole('button', { name: 'Retry original request', exact: true })).toBeEnabled();
        await who.page.reload(); await expect(who.page.getByRole('button', { name: 'Retry original request', exact: true })).toBeEnabled();
        assert.equal(keys.length, 1); assert.equal((await paymentRows(f)).length, 1);
        await who.page.getByRole('button', { name: 'Retry original request', exact: true }).click();
        await expect(who.page.getByRole('heading', { name: 'Your payment is processing.', exact: true })).toBeVisible();
        assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.equal((await paymentRows(f)).length, 1);
        // The recovered GET can already display PROCESSING while the retry's
        // intercepted response is still in flight. Finish it before unroute.
        await retryResponse;
        await who.page.unroute(pattern); await settle(); await who.page.reload();
        await expect(who.page.getByRole('heading', { name: 'Your seats are booked.', exact: true })).toBeVisible();
        const other = await customer(), booking = (await paymentRows(f))[0].booking_id;
        await other.page.goto(c.config.PUBLIC_ORIGIN + '/account/bookings/' + booking);
        await expect(other.page.getByRole('alert')).toBeVisible(); await expect(other.page.locator('.ticket-qr')).toHaveCount(0);
      });
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally {
      for (const context of contexts) await context.close(); await browser?.close(); await web?.close();
    }
  });
});
