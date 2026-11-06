# SeatLedger AI Booking Assistant

## Incremental plan

1. Inspect existing authentication, discovery, inventory, idempotency and browser patterns. Done.
2. Add a modular AI adapter, strict tools, PostgreSQL conversation state, bounded turn processing and a separate confirmation boundary.
3. Add the JSX chat interface with server-created event/seat cards, explicit confirmation, countdown and existing checkout links.
4. Run mock-model unit/integration/browser acceptance plus the complete existing suite.
5. Configure a free-tier Gemini key and verify a real-model conversation separately. The user requested mocked-model tests first and then approved switching the default provider to Gemini. No real provider calls are part of automated acceptance.

## Architecture

The assistant is an interface over existing services. `assistant/` owns conversation metadata and proposes actions; it does not own seats or payments. A model may select read tools and prepare a summary. It cannot execute SQL, arbitrary code, arbitrary URLs, payment, cancellation or an inventory write.

The existing reservation command orchestration is shared by the original reservation routes and the authenticated assistant confirmation route. The same transactional `createReservation`, authorization, idempotency and five-minute expiry remain the booking authority. All model arguments are parsed with Zod. Prices and seat groups come from existing catalogue/availability reads, not model text.

PostgreSQL stores conversations owned by the authenticated user, revisions, short processing leases, bounded transcripts and durable turn request keys. LLM calls happen outside database transactions. Confirmation rechecks authentication, proposal identity, expiry, availability and quoted prices in the existing reservation transaction. Duplicate confirmation recovers the original hold. The assistant never initiates a payment; it links to the existing checkout.

The default adapter uses native Node `fetch` against Google's fixed Gemini `generateContent` endpoint, JSON-schema function declarations, one accepted tool call per response and bounded request/response sizes. It converts the internal agent messages to Gemini content and function responses. Original model parts and opaque thought signatures are returned only to Gemini within the current agent turn; thoughts and signatures are never persisted in the transcript or exposed to the browser. See Google's [Gemini API reference](https://ai.google.dev/api/generate-content) and [thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

OpenAI remains an explicit alternative adapter using its fixed Chat Completions endpoint, strict schemas and `store: false`. There is **no automatic provider fallback**: missing Gemini credentials or exhausted quota cannot trigger an OpenAI request. No AI SDK, orchestration framework or infrastructure dependency was added. The existing server-side Zod validation, explicit confirmation and transactional booking authority apply to both providers.

### Inspection and reuse decisions

Authentication already uses cookie sessions, CSRF tokens and `withAuthorizedSession`, including a post-lock session recheck. Discovery exposes published events and current seating through `discoverEvents`, `publicEvent` and `publicSeats`. Reservation routes owned the idempotency wrapper around `createReservation`; that wrapper is now shared in `reservations/command-service.js`. The underlying allocation service was not changed. Existing checkout, simulator workers, receipts, refunds and tickets remain the customer lifecycle after a hold.

```mermaid
sequenceDiagram
    Customer->>API: Authenticated conversational message + request key
    API->>PostgreSQL: Claim owned conversation revision and short lease
    API->>Gemini: Bounded context + JSON-schema read/proposal tools
    Gemini->>API: Tool arguments checked by server validation
    API->>Existing services: Search / read inventory / calculate options
    API->>PostgreSQL: Save recommendations and proposal
    API-->>Customer: Structured cards and booking summary
    Customer->>API: Explicit Confirm hold action
    API->>Existing reservation command: Transaction, idempotency, locks, five-minute hold
    API->>API: Recheck quoted prices and show metadata; rollback if changed
    API-->>Customer: Saved hold and checkout link
    Customer->>Existing checkout: Separately authorize simulated payment
```

### Tools

| Tool | Existing implementation / behavior |
| --- | --- |
| `searchEvents` | `discoverEvents` + `publicEvent` + `publicSeats`; published shows only, city/category aliases, exact India-time date window, ticket count and budget filters. |
| `getEventDetails` | `publicSeats` reads current event, venue, time, inventory and server-computed starting total. |
| `getAvailableSeats` | `publicSeats`; advisory count only. |
| `recommendSeats` | `publicSeats`; server selects up to three groups. Adjacent means consecutive numbers in the same section and row. |
| `createSeatHold` | **Prepares a two-minute summary only.** It does not write inventory. An opaque option reference resolves to previously server-validated seats and prices. |
| `getBookingStatus` | `readReservation` + `listPayments`, scoped to the authenticated user. No ticket credentials are sent to the model. |
| `clarifyPreferences` | Chooses a field; the server supplies a safe clarification question, including total versus per-ticket budget. |

Budget amounts are integer paise. A total budget caps the whole group; a per-ticket budget caps every individual ticket. Budget filtering currently means INR. Without a budget, other single-currency groups can be returned. Bangalore/Bengaluru and common music/movie/comedy aliases are supported; other categories use the existing exact category lookup. The centre preference uses the physical row's midpoint. Adjacent seating defaults on for groups of more than one.

The model chooses tools and extracts structured preferences. Displayed recommendations, totals, questions and transactional claims use server templates and cards. Arbitrary final model text is never rendered. Event images are not fabricated: SeatLedger's current event data has no image field.

### State, concurrency and recovery

Conversations last 24 hours, belong to the authenticated user, and retain current structured preferences, ordered offer/option references, the current proposal and the last confirmed hold. `null` preference fields preserve prior context, so a cheaper-options follow-up keeps city, category and ticket count. Relative dates are recalculated using database time and Asia/Kolkata. Explicit ranges are limited to 32 inclusive calendar days.

A short transaction claims a revision and a 90-second lease. No LLM request holds a database connection or transaction. Completion rechecks authentication and the lease token; a late result cannot replace another API instance's recovered result. A crashed process leaves a lease that can be reclaimed after expiry using the original request key. At most three attempts can run for a turn, with at most 20 distinct turns per conversation. Completed duplicate keys return the saved conversation without another LLM call; a changed body with the same key is rejected.

Transcripts retain bounded recent messages plus the greeting. Earlier messages are trimmed above 64 KB; the UI reports that trimming. Structured current preferences and hold state are retained separately. Only the last eight message texts and bounded current offer/option metadata are sent to the selected provider. No session token, API key, user ID, customer email or ticket credential is intentionally included in model context.

The tab stores an account-scoped conversation reference and, while unresolved, the original draft/confirmation command. No credentials or QR tickets are stored there. A lost response requires a read before an explicit retry. Page reload and status polling perform reads, never automatic booking/payment retries. A duplicate confirmation uses the server proposal ID as the stable reservation idempotency reference and recovers the same hold, including its original expiry. Historical hold cards cannot present an old ACTIVE checkout action; the current hold is reread through the existing reservation service.

Expired HELD inventory from the existing advisory seat API is conservatively omitted until the expiry worker makes it AVAILABLE. Actual reservation ownership and expiry are always decided by the existing transaction, never by the model or browser countdown.

## Files

New files:

```text
AI_ASSISTANT.md
apps/api/src/assistant/
  agent.js                 bounded model/tool loop and server-grounded replies
  conversations.js         ownership, revisions, leases, usage limits, recovery
  gemini-client.js         native Gemini protocol, signed tool continuation
  llm-client.js            fixed OpenAI endpoint and injectable test transport
  model.js                 explicit provider selection; no automatic fallback
  preferences.js           retained filters, calendar windows, seat ranking
  routes.js                authenticated endpoints and explicit confirmation
  schemas.js               strict Zod HTTP/tool arguments
  tools.js                 controlled tool definitions and service adapters
apps/api/src/reservations/command-service.js
apps/web/src/assistant/
  Assistant.jsx            conversation, cards, summary, countdown, checkout
  assistant.css            responsive styling using existing SeatLedger colors
  client.js                bounded transport and response validation
  store.js                 single-flight UI and tab recovery journal
db/migrations/020_ai_assistant.sql
tests/assistant.test.js
tests/assistant-ui.test.js
tests/gemini.test.js
tests/db/assistant.test.js
tests/browser/assistant.test.js
tests/helpers/assistant-model.js
benchmarks/assistant-2026-11-06.json
benchmarks/assistant-gemini-2026-11-06.json
benchmarks/assistant-ui-2026-11-07.json
```

Modified files: `.env.example`, `README.md`, `package.json`, `apps/api/src/app.js`, `apps/api/src/config.js`, `apps/api/src/logger.js`, `apps/api/src/reservations/routes.js`, `apps/web/src/App.jsx`, `apps/web/src/discovery/Discovery.jsx`, `apps/web/src/reservations/model.js`, and `scripts/lib/evidence-fixture.js`. The test fixture accepts an injected model/configuration; there is no environment switch or public endpoint for a fake production model. Existing migrations and test assertions are preserved.

## Configuration

Run `npm run db:migrate` to apply additive migration 020 before enabling the feature. Use the API server's `.env` locally and Render's private environment for hosting. Do not put any of these secrets in `VITE_*` variables or Vercel frontend code.

### Free-tier Gemini setup

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey). Use a project on the **Free tier**; enabling paid billing is not required for supported free-tier models.
2. Set these variables in the API server's private `.env` or Render environment, replacing the placeholder privately:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your_private_key_here
GEMINI_MODEL=gemini-3.1-flash-lite
AI_ASSISTANT_ENABLED=true
```

3. Apply migration 020 and restart/redeploy the API. Sign in and open `/assistant` for a real-model smoke test: search, select an event, request adjacent seats, review a summary, explicitly confirm, then independently authorize simulated checkout.

Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite) lists this model's input/output as free on the Free tier. Limits depend on the project/model and can change; view your actual allowance in AI Studio. This application does not enable billing, create a paid project or silently move to a paid provider. A key from an already billed project follows that project's billing rules; the application cannot infer its account tier from the key. Free-tier content may be used to improve Google's products under its published terms, so use fictional demo conversations and avoid sensitive information.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_ASSISTANT_ENABLED` | `false` | Exact `true` enables the feature when a server key exists. |
| `AI_PROVIDER` | `gemini` | Explicit `gemini` or `openai`; no automatic fallback. |
| `GEMINI_API_KEY` | absent | Private Google AI Studio credential; no OpenAI key is needed. |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Configurable Gemini model supporting function calling. Default uses minimal thinking and the native REST API. |
| `OPENAI_API_KEY` | absent | Optional alternative; used only when `AI_PROVIDER=openai`. |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Optional alternative model when `AI_PROVIDER=openai`. |
| `AI_USER_TURNS_PER_HOUR` | `20` | Maximum started attempts per authenticated user in a UTC hour. |
| `AI_GLOBAL_TURNS_PER_HOUR` | `50` | Maximum started attempts across all API instances in a UTC hour. |
| `AI_GLOBAL_TURNS_PER_DAY` | `200` | Maximum started attempts across all instances in a UTC day. |
| `AI_CONVERSATIONS_PER_DAY` | `5` | Per-user creation limit over the preceding 24 hours. |

Usage counters live in PostgreSQL and include failed/retried model attempts. Cache replays do not consume another allowance. They limit attempts, not exact billed currency. Each attempt allows up to four model calls, three tool calls, 1,600 completion tokens per call, 48 KB of serialized input context, 128 KB provider responses, a 20-second provider request and a 45-second agent deadline. Searches inspect at most 20 distinct events, 24 shows and return at most eight offers; truncated searches tell the user to narrow filters. These bounds are deliberately conservative for the hosted demo.

Missing configuration returns `enabled: false` from the status endpoint and a useful unavailable screen. It does not prevent normal SeatLedger booking or server startup. To disable the feature, set `AI_ASSISTANT_ENABLED=false`; keep migration 020 applied.

## Interface improvements (2026-11-07)

The assistant now uses a compact header, a four-step booking indicator, a bounded conversation area and a separate booking-details panel. Desktop keeps the current selection alongside the conversation; mobile stacks the details below the chat, with an explicit jump link from the latest summary or saved hold. The composer remains outside the scrolling transcript so it does not get buried by past recommendations.

Event and seat cards use larger text, clear total prices and distinct primary actions. Earlier cards live in expandable history without stale action buttons. Starter prompts and cheaper/adjacent-seat shortcuts only fill an editable draft; they never submit a request or consume model quota by themselves. Enter submits once, Shift+Enter creates a new line, and IME composition is respected. The existing single-flight store, confirmation endpoint and payment authorization boundaries are unchanged.

Only one current confirmation action is shown in booking details. Expired proposals offer a fresh-seat draft instead of a Confirm button. Current holds show the server-read status, a large countdown and the existing checkout link. The disabled assistant still offers the regular programme.

Focused browser checks cover editable starters, keyboard submission, collapsed history, inactive historical card actions, the summary/hold/checkout/QR flow, lost-confirmation recovery, expired summaries and horizontal overflow at 320, 390, 768, 820, 1024 and 1280 pixels. Screenshots include `test-results/assistant/desktop-start.png`, `desktop.png`, `mobile.png` and `mobile-seats.png`.

UI verification on 2026-11-07: production build passed; all 155 unit tests, all 86 browser entries and all 10 targeted assistant database/API tests passed with zero failures. The browser journeys exercise the built UI against real authenticated APIs, PostgreSQL and simulated-payment workers with a mocked model. No booking-engine code changed. The complete database profile was not repeated for this UI change; the prior full database results are recorded below. See [the UI verification summary](benchmarks/assistant-ui-2026-11-07.json) for logs, screenshots and limits. These are local acceptance results; hosted release verification is a separate check.

## HTTP API

All endpoints require an existing authenticated session and return `Cache-Control: no-store`. All mutations require the existing allowed `Origin`, `Content-Type: application/json`, `X-SeatLedger-Client: web`, and `X-CSRF-Token`. No caller supplies a user ID. Unknown query/body fields are rejected. Requests have the application's existing 16 KB JSON limit.

| Method / path | Input | Result |
| --- | --- | --- |
| `GET /api/assistant/status` | none | Enabled state, maximum eight tickets, search timezone and simulated-payment marker. |
| `POST /api/assistant/conversations` | `{}` + UUID `Idempotency-Key` | `201` owned conversation; repeated creation key recovers it. |
| `GET /api/assistant/conversations/:id` | none | `200` current snapshot; other users and expired conversations get `404`. |
| `POST /api/assistant/conversations/:id/messages` | `{ "message": "Find comedy in Bangalore...", "revision": 0 }` + UUID `Idempotency-Key` | `200` updated snapshot with structured cards. Text length 1–1,500. |
| `POST /api/assistant/conversations/:id/confirm-hold` | `{ "proposalId": "<server UUID>", "revision": 3, "confirmed": true }` | `201` saved/recovered hold and checkout path. Proposal identity provides idempotency; prices, seat IDs and user IDs are not accepted in this body. |

A snapshot contains `id`, `revision`, `messages` with `role`, `text` and typed `cards`, retained `preferences`, `proposal`, current `hold`, pending-turn recovery metadata, `busy`, `serverNow`, `expiresAt` and `paymentMode: simulated`. Event/seat/proposal cards contain server-read show metadata and minor-unit prices. The hold uses the original reservation response plus a validated internal checkout link. The current hold's `bookingPath` links to an owned receipt after payment.

Expected failures: `401 AUTH_REQUIRED`, `403 CSRF_REJECTED`, `404 NOT_FOUND`, `409 ASSISTANT_BUSY/ASSISTANT_CONFLICT/STALE_RECOMMENDATION/QUOTE_EXPIRED/QUOTE_CHANGED/SEATS_UNAVAILABLE`, `429 AI_RATE_LIMITED/AI_RETRY_LIMIT`, and sanitized `502/503/504` AI errors. Rate-limited requests include `Retry-After`. Existing reservation errors can also apply. No provider error body, internal prompt or raw exception is returned.

## Verification and remaining work

Automated tests inject deterministic model responses or a mock HTTP transport. They make **no real Gemini or OpenAI API calls**. They validate structured preference extraction contracts and integration, not the real model's language accuracy. Gemini-specific cases cover native function-declaration serialization, private key headers, signed continuation, native call IDs, quota errors with retry hints, safety-blocked/truncated/malformed/multi-call responses, fixed-host validation and the absence of paid-provider fallback. A native Gemini HTTP fixture drives authenticated search, recommendations, summary and the original hold command through PostgreSQL.

Focused checks cover search/context retention, strict tool schemas and arguments, tool selection, duplicate tool caching, per-ticket/total budgets, adjacency, India-time dates, owned status reads, cross-user isolation, CSRF, missing confirmation, duplicate two-instance confirmation, changed prices, unavailable seats, expired summaries/holds, same-key failure recovery, logout fencing, expired processing leases, iteration/time limits, malformed provider output, response-size limits, journal storage failure and lost-response recovery.

The built-browser test uses the real API, PostgreSQL reservation/payment services, simulator callback and ticket generation with a mocked model. It verifies two-seat QR issuance, reload recovery, no automatic second confirmation POST after a lost acknowledgement, logout privacy, no external browser requests, and 320px layout. Desktop/mobile screenshots are written under ignored `test-results/assistant/`.

Commands:

```powershell
npm test
npm run test:db
npm run test:browser:assistant
# Complete isolated regression, all browsers, load and database outage checks:
$env:SEATLEDGER_OPERATIONS_BROWSER='true'
$env:SEATLEDGER_BROWSER_CHANNEL='chrome'
npm run verify:operations
```

Observed locally on 2026-11-06:

| Check | Result |
| --- | --- |
| Complete unit suite, including Gemini adapter tests | 155 passed, 0 failed |
| Complete PostgreSQL/API/security/recovery suite, fresh rerun | 241 passed, 0 failed |
| All built-browser journeys | 84 entries passed, 0 failed |
| Production Vite build | Passed |
| Assistant database cases including native Gemini fixtures | 10 passed, 0 failed; subset of the database total |
| Two-instance load cases | 1,000 requests each, up to 250 concurrent; one seat: 1 hold/999 conflicts, one show: 500/500, many shows: 1,000/0; no unexpected responses or invalid allocations |
| Database pause/unpause | Readiness 503, liveness 200; same API recovered pending work with two competing workers, one provider effect and one booking |

The Gemini provider implementation matrix totals **480 entries**. No existing test was removed or weakened. The load test measures the existing reservation path, not AI throughput. The outage test uses a paused disposable database, not data loss or disaster recovery.

Portable current result summary: [benchmarks/assistant-gemini-2026-11-06.json](benchmarks/assistant-gemini-2026-11-06.json). Detailed local evidence: `test-results/operations/2026-11-06T15-32-38.604Z/acceptance.json` and its per-check logs, plus `test-results/gemini-database-recheck.log`.

The first database profile recorded a Windows native process exit (`3221226505`) in the existing organizer-operations test, with no assertion failure. The **entire database suite** then passed on a fresh disposable database. The original report remains marked failed and is retained unchanged; the latest matrix combines its passing unit/build/browser/load/outage results with the clean database rerun. The earlier pre-Gemini 473-entry matrix remains in [benchmarks/assistant-2026-11-06.json](benchmarks/assistant-2026-11-06.json). Disposable Docker projects were removed after verification; application/hosted database data was not migrated or changed by these tests.

Remaining limitations: real Gemini/OpenAI semantics, account/model access, latency, free-tier quota and provider billing require a separately configured key and live test. Deploying the application does not enable the assistant automatically: its selected provider key and feature flag must be configured on the API server. Search is bounded rather than exhaustive, dates use India time, conversations have explicit size/turn/age limits, and no event images exist in the current data model. Expired conversation rows are physically deleted opportunistically when that owner creates another conversation; global retention cleanup for inactive users and historical usage buckets remains an operational maintenance task. Existing confirmation delivery remains the application's simulated in-app flow; this feature does not add an external email/SMS provider. Production conversation privacy, provider retention policy and spending settings should be reviewed before expanding beyond the demo.
