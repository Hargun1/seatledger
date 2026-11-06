# SeatLedger

A JavaScript ticket-booking demo with PostgreSQL seat ownership, expiring holds, idempotent simulated payments, durable workers, printable QR tickets, and organizer admission controls.

[Live demo](https://seatledger-hargun1.vercel.app) · [GitHub](https://github.com/Hargun1/seatledger)

[Project notes, architecture, interview study guides and verification evidence](https://app.notion.com/p/40973094586e81519afcd08de2b94405) live in Notion.

## Run locally

Requires Node.js 24, npm, Docker and Docker Compose.

1. `npm ci`
2. Copy `.env.example` to `.env` and set `ALLOW_DEV_SEED=true` for the first local seed.
3. `npm run auth:secret` and `npm run payments:secret`
4. `docker compose up -d db`
5. `npm run db:migrate` and `npm run db:seed`
6. `npm run dev` (web on port 5173, API on port 4100).
7. Start `npm run worker:expiry`, `npm run workers:payments`, and `npm run worker:event-cancellations` for asynchronous processing.

Payments are simulated. Public registration creates a customer; organizer approval requires administrative access. Demo data is fictional.

## Check

`npm test`, `npm run test:db`, `npm run build`, and the `test:browser:*` scripts run the acceptance checks. `npm run verify:foundation` uses a disposable Docker database. Set `SEATLEDGER_BROWSER_CHANNEL=chrome` to use installed Chrome locally; CI installs Chromium.

`npm run verify:operations` demonstrates worker retries/duplicates, security controls, 1,000 booking requests across two APIs, protected metrics/traces, and recovery after a database outage. See [operations, test profiles and evidence limits](OPERATIONS.md).

## Host

The Vercel frontend proxies `/api` to the Render backend. Neon stores PostgreSQL data. `render.yaml` and `vercel.json` describe the hosting configuration. Use a pooled `DATABASE_URL` and a direct `MIGRATION_DATABASE_URL`; keep signing secrets private. The production supervisor runs the API and all six workers together. Free Render hosting sleeps when idle, so queued work resumes after wake-up. Physical camera and paper-printer acceptance requires devices.
