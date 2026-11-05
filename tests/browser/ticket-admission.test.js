import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import jsQR from 'jsqr';
import { createPool } from '../../apps/api/src/db.js';
import { readDatabaseConfig } from '../../apps/api/src/config.js';
import { createApp } from '../../apps/api/src/app.js';
import { newToken, csrfFor, digest } from '../../apps/api/src/auth/security.js';
import { issueTickets, readTickets } from '../../apps/api/src/bookings/tickets.js';
import { ticketQr } from '../../apps/web/src/bookings/ticket-qr.js';
import { installReliabilitySchema } from '../helpers/reliability-schema.js';
import { paymentFixture } from '../helpers/payment-fixture.js';

// Authored, not an execution claim. SQL-funded booking setup is synthetic.
// All admission/owned reads use the built UI, real HTTP and private PostgreSQL.
// Camera media is generated in-browser; this does not test a physical device.
function fakeCamera({ native = false } = {}) {
  if (!navigator.mediaDevices) return; // Initial about:blank is not the test's secure loopback document.
  const state = window.__ticketTest = { permission: 'allow', code: '', symbol: null, detectMode: 'normal', captures: 0, detections: 0, tracks: [] };
  state.live = () => state.tracks.filter(track => track.readyState === 'live').length;
  function acquire() {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 450;
    const context = canvas.getContext('2d');
    const draw = () => {
      context.setTransform(1, 0, 0, 1, 0, 0); context.fillStyle = '#fff'; context.fillRect(0, 0, 450, 450);
      if (state.symbol) { context.scale(450 / state.symbol.size, 450 / state.symbol.size); context.fillStyle = '#000'; context.fill(new Path2D(state.symbol.path)); }
    };
    draw(); const stream = canvas.captureStream(10), timer = setInterval(draw, 100);
    for (const track of stream.getTracks()) {
      state.tracks.push(track); const original = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); original(); canvas.width = canvas.height = 0; };
    }
    return stream;
  }
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async options => {
    if (options.audio !== false) throw new Error('Unexpected audio capture');
    state.captures++;
    if (state.permission === 'deny') throw new DOMException('Fixture denial', 'NotAllowedError');
    if (state.permission === 'defer') return new Promise(resolve => { state.grant = () => resolve(acquire()); });
    return acquire();
  } });
  class Detector {
    static async getSupportedFormats() { return ['qr_code']; }
    async detect() {
      state.detections++;
      if (state.detectMode === 'defer') return new Promise(resolve => { state.finishDetection = () => resolve([{ rawValue: state.code }]); });
      return state.code ? [{ rawValue: state.code }] : [];
    }
  }
  Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: native ? Detector : undefined });
}

async function decodeVisibleQr(locator) {
  const image = await locator.evaluate(svg => {
    const size = svg.viewBox.baseVal.width, width = size * 5, canvas = document.createElement('canvas');
    canvas.width = canvas.height = width; const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, width); context.scale(5, 5);
    context.fillStyle = '#000'; context.fill(new Path2D(svg.querySelector('path').getAttribute('d')));
    return { width, pixels: Array.from(context.getImageData(0, 0, width, width).data) };
  });
  return jsQR(new Uint8ClampedArray(image.pixels), image.width, image.width)?.data;
}

test('owned QR tickets and entrance admission through built UI, HTTP and PostgreSQL (generated camera)', { timeout: 180000 }, async t => {
  const database = readDatabaseConfig().DATABASE_URL, adminPool = createPool(database), contexts = [], pageErrors = [], externalOrigins = [];
  const config = { NODE_ENV: 'test', AUTH_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '', PAYMENT_MODE: 'simulated' };
  let admin, schema, pool, api, web, browser, staff;
  const receiptPath = f => '/account/bookings/' + f.booking;
  const entrancePath = f => `/organizers/${f.org}/events/${f.event}/shows/${f.show}/check-in`;
  const admissionPath = f => `/api/organizers/${f.org}/shows/${f.show}/check-ins`;
  const count = async f => (await pool.query('SELECT count(*)::int AS n FROM ticket_checkins WHERE show_id=$1', [f.show])).rows[0].n;
  async function actor(existingId, cameraOptions) {
    const id = existingId || randomUUID(), token = newToken();
    if (existingId) await pool.query("UPDATE users SET status='ACTIVE',password_hash='browser-fixture-not-a-login-password' WHERE id=$1", [id]);
    else await pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,'Admission UI fixture','browser-fixture-not-a-login-password')", [id, `${id}@example.invalid`]);
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [id, digest(token), digest(csrfFor(token, config.AUTH_SECRET))]);
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' }); contexts.push(context);
    await context.route('**/*', route => {
      const origin = new URL(route.request().url()).origin;
      if (origin === config.PUBLIC_ORIGIN) return route.continue();
      externalOrigins.push(origin); return route.abort('blockedbyclient');
    });
    await context.addCookies([{ name: 'seatledger_session', value: token, url: config.PUBLIC_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
    if (cameraOptions) await context.addInitScript(fakeCamera, cameraOptions);
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    const posts = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/check-ins$/.test(new URL(request.url()).pathname)) posts.push(request.postDataJSON()); });
    return { id, page, posts };
  }
  async function fixture({ issued = true } = {}) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN'); const f = await paymentFixture(db), reservation = await f.reservation(), booking = await f.booking(reservation), payment = await f.attempt(reservation);
      await f.capture(payment, booking);
      const meta = (await db.query('SELECT organizer_id AS org,event_id AS event FROM shows WHERE id=$1', [f.show])).rows[0];
      await db.query("UPDATE organizers SET status='APPROVED',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1", [meta.org, staff.id]);
      await db.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'STAFF')", [meta.org, staff.id]);
      await db.query("UPDATE events SET status='PUBLISHED',title='An evening <script>literal</script>' WHERE id=$1", [meta.event]);
      await db.query("UPDATE shows SET starts_at=clock_timestamp()+interval '7 days',base_price_minor=75000,currency='INR' WHERE id=$1", [f.show]);
      await db.query("UPDATE show_seats SET state='BOOKED',reservation_id=$1,booking_id=$2,expires_at=NULL WHERE show_id=$3", [reservation.id, booking, f.show]);
      if (issued) await issueTickets(db, f.user, booking);
      await db.query('COMMIT');
      const tickets = await readTickets(pool, f.user, booking, config.AUTH_SECRET);
      return { ...meta, show: f.show, user: f.user, booking, ticket: tickets.tickets[0] };
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async function entrance(who, f) {
    await who.page.bringToFront(); await who.page.goto(config.PUBLIC_ORIGIN + entrancePath(f));
    await expect(who.page.getByLabel('Admission credential', { exact: true })).toBeEnabled();
  }
  async function start(who, f, code = f.ticket.credential) {
    await who.page.bringToFront();
    await who.page.evaluate(({ code, symbol }) => { window.__ticketTest.code = code; window.__ticketTest.symbol = symbol; }, { code, symbol: ticketQr(code) });
    await who.page.getByRole('button', { name: 'Start camera QR scan', exact: true }).click();
  }
  async function journal(who) {
    return who.page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('seatledger:checkin:')).map(key => JSON.parse(sessionStorage.getItem(key))));
  }
  async function scenario(name, work) {
    let failed; await t.test(name, async () => { try { await work(); } catch (error) { failed = error; throw error; } }); if (failed) throw failed;
  }
  try {
    admin = await adminPool.connect(); await admin.query('BEGIN'); schema = await installReliabilitySchema(admin, 'auth_test');
    for (const name of ['006_auth_throttling.sql', '007_organizer_review_versions.sql', '008_venue_management.sql', '009_draft_shows.sql', '010_event_publication.sql', '011_reservation_recovery.sql', '012_simulated_provider.sql', '013_payment_event_evidence.sql', '014_simulated_event_delivery.sql', '015_admission_tickets.sql', '016_simulated_refunds.sql', '017_payment_history.sql', '018_show_booking_history.sql', '019_event_cancellation_jobs.sql']) await admin.query(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('COMMIT'); const connection = new URL(database); connection.searchParams.set('options', `-c search_path=${schema},public`); pool = createPool(connection.toString());
    api = createApp({ pool, config, logger: { info() {}, error() {} } }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { api.once('listening', resolve); api.once('error', reject); });
    web = await preview({ configFile: false, root: fileURLToPath(new URL('../../apps/web', import.meta.url)), logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
    config.PUBLIC_ORIGIN = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ ...(process.env.SEATLEDGER_BROWSER_CHANNEL ? { channel: process.env.SEATLEDGER_BROWSER_CHANNEL } : {}), args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
    staff = await actor(undefined, { native: false });

    await scenario('owned issue/reveal/hide, independent DOM-vector decode, private print refresh and foreign denial', async () => {
      const f = await fixture({ issued: false }), customer = await actor(f.user), foreign = await actor(); const page = customer.page;
      await page.goto(config.PUBLIC_ORIGIN + receiptPath(f));
      await page.getByRole('button', { name: 'Issue or recover tickets', exact: true }).click();
      const reveal = page.getByRole('button', { name: 'Show private QR & admission code', exact: true }); await expect(reveal).toBeVisible();
      await expect(page.getByRole('img', { name: 'Private admission QR code', exact: true })).toHaveCount(0); await reveal.click();
      const credential = (await readTickets(pool, f.user, f.booking, config.AUTH_SECRET)).tickets[0].credential;
      assert.equal(await decodeVisibleQr(page.getByRole('img', { name: 'Private admission QR code', exact: true })), credential);
      assert.equal(page.url().includes(credential), false); assert.equal(await page.locator('main script').count(), 0);
      assert.equal(await page.evaluate(code => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(code), credential), false);
      await page.getByRole('button', { name: 'Hide private QR & admission code', exact: true }).click(); await expect(page.locator('.ticket-qr')).toHaveCount(0);
      await page.getByRole('link', { name: 'Open private printable tickets', exact: true }).click(); await expect(page.locator('.print-ticket')).toHaveCount(1);
      assert.equal(await decodeVisibleQr(page.locator('.print-ticket .ticket-qr')), credential);
      await page.setViewportSize({ width: 320, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.getByRole('button', { name: 'Hide private preview', exact: true }).click(); await expect(page.locator('.print-ticket')).toHaveCount(0);
      await page.getByRole('button', { name: 'Refresh private preview', exact: true }).click(); await expect(page.locator('.print-ticket')).toHaveCount(1);
      await foreign.page.goto(config.PUBLIC_ORIGIN + receiptPath(f)); await expect(foreign.page.getByRole('alert')).toBeVisible(); await expect(foreign.page.locator('.ticket-qr')).toHaveCount(0);
      assert.equal(await count(f), 0);
    });

    await scenario('software camera reads actual QR frames; explicit duplicate-safe admission and later withholding', async () => {
      const f = await fixture(); await entrance(staff, f); await start(staff, f);
      await expect(staff.page.getByLabel('Admission credential', { exact: true })).toHaveValue(f.ticket.credential, { timeout: 15000 });
      assert.equal(staff.posts.length, 0); assert.equal(await count(f), 0); assert.equal(await staff.page.evaluate(() => window.__ticketTest.live()), 0);
      assert.deepEqual(await journal(staff), []);
      await staff.page.getByRole('button', { name: 'Check & admit ticket', exact: true }).evaluate(button => { button.click(); button.click(); });
      await expect(staff.page.getByRole('heading', { name: 'Admit this ticket.', exact: true })).toBeVisible(); assert.equal(staff.posts.length, 1); assert.equal(await count(f), 1);
      await staff.page.getByRole('button', { name: 'Ready for next ticket', exact: true }).click();
      await staff.page.getByLabel('Admission credential', { exact: true }).fill(f.ticket.credential); await staff.page.getByRole('button', { name: 'Check & admit ticket', exact: true }).click();
      await expect(staff.page.getByRole('alert')).toContainText('already been checked in'); await expect(staff.page.getByRole('heading', { name: 'Admit this ticket.', exact: true })).toHaveCount(0); assert.equal(await count(f), 1);
      const customer = await actor(f.user); await customer.page.goto(config.PUBLIC_ORIGIN + receiptPath(f)); await expect(customer.page.getByText('This credential is not available for admission.', { exact: true })).toBeVisible();
      await customer.page.goto(config.PUBLIC_ORIGIN + receiptPath(f) + '/tickets/print'); await expect(customer.page.getByRole('heading', { name: 'No printable admission tickets.', exact: true })).toBeVisible(); await expect(customer.page.locator('.ticket-qr')).toHaveCount(0);
    });

    await scenario('lost committed acknowledgement reloads the identity-only journal as historical GET recovery', async () => {
      const f = await fixture(), who = await actor(undefined, { native: true });
      await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'STAFF')", [f.org, who.id]); await entrance(who, f);
      await who.page.route('**' + admissionPath(f), async route => { if (route.request().method() === 'POST') { await route.fetch(); await route.abort('failed'); } else await route.continue(); });
      await start(who, f); await expect(who.page.getByLabel('Admission credential', { exact: true })).toHaveValue(f.ticket.credential);
      await who.page.getByRole('button', { name: 'Check & admit ticket', exact: true }).click(); await expect(who.page.getByText('Keep the original request.', { exact: true })).toBeVisible();
      await expect(who.page.getByRole('alert')).toBeVisible(); assert.equal(await count(f), 1); assert.equal(who.posts.length, 1);
      const saved = await journal(who); assert.equal(saved.length, 1); assert.deepEqual(Object.keys(saved[0]).sort(), ['organizationId', 'requestKey', 'showId', 'ticketId', 'userId']); assert.equal(saved[0].ticketId, f.ticket.id);
      await who.page.reload(); await expect(who.page.getByRole('heading', { name: 'Already recorded.', exact: true })).toBeVisible();
      await expect(who.page.getByRole('heading', { name: 'Admit this ticket.', exact: true })).toHaveCount(0); assert.equal(who.posts.length, 1); assert.deepEqual(await journal(who), []); assert.equal(await count(f), 1);
    });

    await scenario('uncommitted loss retains one request; wrong camera ticket is withheld and exact retry reuses its key', async () => {
      const f = await fixture(), other = await fixture(), who = await actor(undefined, { native: true });
      await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'STAFF')", [f.org, who.id]); await entrance(who, f);
      let intercepted = 0; await who.page.route('**' + admissionPath(f), route => route.request().method() === 'POST' && ++intercepted === 1 ? route.abort('failed') : route.continue());
      await who.page.getByLabel('Admission credential', { exact: true }).fill(f.ticket.credential); await who.page.getByRole('button', { name: 'Check & admit ticket', exact: true }).click();
      await expect(who.page.getByRole('alert')).toBeVisible(); const saved = (await journal(who))[0]; assert.equal(await count(f), 0);
      await who.page.reload(); await expect(who.page.getByRole('alert')).toContainText('No receipt is visible yet');
      await start(who, f, other.ticket.credential); await expect(who.page.getByRole('status')).toContainText('Scan the original ticket');
      await expect(who.page.getByLabel('Admission credential', { exact: true })).toHaveValue(''); assert.equal(who.posts.length, 1);
      await who.page.evaluate(code => { window.__ticketTest.code = code; }, f.ticket.credential);
      await expect(who.page.getByLabel('Admission credential', { exact: true })).toHaveValue(f.ticket.credential);
      await who.page.getByRole('button', { name: 'Retry original check-in', exact: true }).click(); await expect(who.page.getByRole('heading', { name: 'Admit this ticket.', exact: true })).toBeVisible();
      assert.equal(who.posts.length, 2); assert.equal(who.posts[1].requestKey, saved.requestKey); assert.equal(who.posts[0].requestKey, saved.requestKey); assert.equal(await count(f), 1); assert.deepEqual(await journal(who), []);
    });

    await scenario('permission fallback, late grant, stopped detection and navigation cannot fill or admit', async () => {
      const f = await fixture(), who = await actor(undefined, { native: true });
      await pool.query("INSERT INTO organizer_memberships(organizer_id,user_id,role) VALUES($1,$2,'STAFF')", [f.org, who.id]); await entrance(who, f);
      await who.page.evaluate(() => { window.__ticketTest.permission = 'deny'; }); await start(who, f);
      await expect(who.page.getByRole('status')).toContainText('Camera access was not granted'); await expect(who.page.getByLabel('Admission credential', { exact: true })).toBeEnabled();
      await who.page.evaluate(() => { window.__ticketTest.permission = 'defer'; }); await start(who, f);
      await expect.poll(() => who.page.evaluate(() => typeof window.__ticketTest.grant)).toBe('function'); await who.page.getByRole('button', { name: 'Stop camera', exact: true }).click();
      await who.page.evaluate(() => window.__ticketTest.grant()); await expect.poll(() => who.page.evaluate(() => window.__ticketTest.live())).toBe(0);
      assert.equal(await who.page.evaluate(() => window.__ticketTest.tracks.length), 1);
      await who.page.evaluate(() => { window.__ticketTest.permission = 'allow'; window.__ticketTest.detectMode = 'defer'; }); await start(who, f);
      await expect.poll(() => who.page.evaluate(() => typeof window.__ticketTest.finishDetection)).toBe('function');
      await who.page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.__ticketTest.finishDetection(); });
      await expect.poll(() => who.page.evaluate(() => window.__ticketTest.live())).toBe(0); await expect(who.page.getByLabel('Admission credential', { exact: true })).toHaveValue('');
      await who.page.evaluate(() => { window.__ticketTest.detectMode = 'normal'; window.__ticketTest.code = ''; });
      await who.page.getByRole('button', { name: 'Start camera QR scan', exact: true }).click(); await expect.poll(() => who.page.evaluate(() => window.__ticketTest.live())).toBe(1);
      await who.page.getByRole('link', { name: 'Back to show', exact: true }).click(); await expect.poll(() => who.page.evaluate(() => window.__ticketTest.live())).toBe(0);
      assert.equal(who.posts.length, 0); assert.equal(await count(f), 0);
    });

    await scenario('cached copy cannot bypass parent cancellation or foreign entrance scope', async () => {
      const f = await fixture(), customer = await actor(f.user), foreign = await actor(); await entrance(staff, f);
      await pool.query("UPDATE events SET status='CANCELLED' WHERE id=$1", [f.event]);
      await staff.page.getByLabel('Admission credential', { exact: true }).fill(f.ticket.credential); await staff.page.getByRole('button', { name: 'Check & admit ticket', exact: true }).click();
      await expect(staff.page.getByRole('alert')).toContainText('cannot be admitted'); assert.equal(await count(f), 0);
      await customer.page.goto(config.PUBLIC_ORIGIN + receiptPath(f)); await expect(customer.page.getByText('This credential is not available for admission.', { exact: true })).toBeVisible(); await expect(customer.page.locator('.ticket-qr')).toHaveCount(0);
      await foreign.page.goto(config.PUBLIC_ORIGIN + entrancePath(f)); await expect(foreign.page.getByRole('alert')).toBeVisible(); await expect(foreign.page.getByLabel('Admission credential', { exact: true })).toHaveCount(0);
    });
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalOrigins, []);
  } finally {
    for (const context of contexts) await context.close(); await browser?.close(); await web?.close();
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await pool?.end();
    if (admin) { await admin.query('ROLLBACK'); if (schema) { assert.match(schema, /^auth_test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } admin.release(); }
    await adminPool.end();
  }
});
