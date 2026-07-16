# Background worker, queues & email delivery

OpenBooks runs durable background work on **BullMQ + Redis** with a standalone
worker process — the scalable home for scheduled work (reports today;
scripts/notifications next). Ported from the beaconhs-platform architecture.

## Pieces

- **`packages/jobs`** (`@openbooks/jobs`) — Redis connection + BullMQ queues.
  - `getConnection()` (bounded-retry producer) / `getBlockingConnection()` (worker).
  - Queues: `emails` (`enqueueEmail`, one job per recipient), `reports`
    (`enqueueReportRun`). Add a queue module here to grow the system.
- **`packages/emails`** (`@openbooks/emails`) — provider abstraction (Resend,
  SendGrid, Mailgun, Postmark, SMTP) + AES-GCM secret sealing. `sendVia(transport,
  input)` does the network send (HTTP via `fetch`, SMTP via lazy `nodemailer`),
  attachments supported. No implicit provider — every send resolves an explicit
  per-org transport.
- **`engine/src/email-config.ts`** — per-org config in `orgs.settings.email`
  (secret sealed via `SESSION_SECRET`-derived key), `email_log` writes,
  `resolveOrgEmailTransport(orgId)`.
- **`engine/src/worker/`** — the worker process (`index.ts` boots it):
  - `email-worker` consumes `emails` → resolves the org transport, sends, logs.
  - `reports-worker` consumes `reports` → renders the PDF (calls the web internal
    render endpoint) → fans out an email job per recipient → records `report_runs`.
  - `scheduler` scans `report_schedules` every 60s, claims due ones
    (`UPDATE … WHERE next_run_at = $old`), advances the cadence, enqueues a job.
- **Web** — `/api/internal/reports/render` (token-guarded PDF render for the
  worker), `/api/admin/email` (config GET/PUT, secret sealed), `/api/admin/email/test`
  (synchronous test send), and the settings UI at `/admin/email`.

## Flow (scheduled report)

```
report_schedules (due) ──scheduler──▶ reports queue ──reports-worker──▶
  render PDF (web internal endpoint) ──▶ emails queue (1/recipient) ──email-worker──▶
    sendVia(org transport) ──▶ provider ; every step logged in email_log
```

## Run

```
npm run worker         # tsx engine/src/worker/index.ts  (needs Redis + DB)
```

Deploy it as its own service alongside `web` (same image/env), like beaconhs's
`apps/worker`.

## Env

| Var | Purpose | Default (dev) |
|---|---|---|
| `OPENBOOKS_REDIS_URL` | Redis for BullMQ (falls back to `REDIS_URL`) | `redis://localhost:6379` |
| `OPENBOOKS_APP_URL` | Web base URL the worker renders against | `http://localhost:4780` |
| `OPENBOOKS_INTERNAL_TOKEN` | Shared token for the internal render endpoint | — (set in prod) |
| `SESSION_SECRET` | Also derives the email secret-sealing key (≥32 chars in prod) | dev fallback |

Provider secrets are never stored in plaintext or returned to the UI — only
`hasSecret` is exposed. `sendVia` redacts credentials from any error text.

## Verified

Crypto seal/unseal (+ tamper→null), a real SMTP send via Ethereal (with a PDF
attachment), and a BullMQ enqueue→consume round-trip (per-recipient fanout) all
pass on local Redis. Full schedule→render→email e2e pends the dev DB being
reachable.
