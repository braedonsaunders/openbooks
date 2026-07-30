# Contributing to OpenBooks

OpenBooks welcomes accounting expertise, code, tests, documentation, design,
translations, deployment improvements, and reproducible bug reports.

The project is an accounting system before it is a collection of screens.
Changes that affect money, posting, permissions, audit evidence, or tenant data
must preserve the controls described below.

## Before starting

- Search existing issues and pull requests.
- Open an issue before a large feature, schema redesign, or behavior change so
  the accounting treatment and migration path can be agreed first.
- Never include customer records, production exports, credentials, private
  infrastructure details, or generated build/test output in a contribution.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js 24 or newer
- npm
- PostgreSQL 16
- Redis 7 for queue-backed functionality

```bash
npm ci
cp .env.example .env
# Configure a disposable development database in .env.
npx tsx scripts/bootstrap.ts
npm run dev -w web
```

The application listens on `http://localhost:4780` in development.

For a packaged deployment, use the root `compose.yaml` through:

```bash
./scripts/compose-up.sh
```

Do not run integration tests, migration experiments, simulations, or destructive
maintenance commands against production or shared data.

## Financial integrity requirements

Every accounting change must preserve:

- strict organization and legal-entity isolation;
- balanced, deterministic, idempotent posting;
- exact decimal and currency handling without floating-point financial math;
- closed-period immutability and controlled correction evidence;
- explicit lifecycle transitions, approvals, permissions, and concurrency
  behavior;
- complete audit evidence for material configuration and transaction changes;
- effective-dated financial configuration where changing a rule could
  reinterpret history;
- domain- and API-level enforcement rather than UI-only controls;
- backward-compatible migrations and preserved tenant data; and
- one authoritative source for each policy or feature setting.

Organization feature gates belong on **Company Settings → Features**. A
module-specific page may explain effective state and link there, but it must not
persist a second gate. Child capabilities must fail closed when their parent
feature is disabled. Disabling a feature must preserve its data and audit
history.

## Code and product conventions

- Use TypeScript and keep strict type checking clean.
- Use the money helpers and decimal strings for financial values. Do not convert
  financial amounts through JavaScript `number`.
- Scope tenant-owned records by `org_id`; add and test row-level security for new
  tenant tables.
- Add permissions and server-side enforcement for every mutation.
- Make retries safe. External callbacks, imports, posting, and workers require
  stable idempotency behavior.
- Posted corrections require explicit lineage and audit evidence.
- Add generated and handwritten migrations as required. Never edit an applied
  migration to reinterpret existing databases.
- Keep user-visible copy in all seven locale catalogs: `en`, `fr`, `es`, `de`,
  `pt-BR`, `zh`, and `ja`.
- Keep optional organization features in the centralized registry at
  `web/lib/features.ts`.
- Add or update in-product documentation for material user workflows.

## Tests

Run the release gate before requesting review:

```bash
npm run verify:release
```

That command type-checks workspaces, runs the test suite, and creates a
production build. Database-backed tests execute when `OPENBOOKS_DB_URL` points
to a bootstrapped scratch database; they skip when no database is configured.
CI includes a canary that fails if database tests silently skip.

For browser smoke tests:

```bash
npx playwright install chromium
npx playwright test
```

New accounting behavior should include:

- nominal examples;
- boundary and rounding cases;
- invalid-state rejection;
- idempotent retry behavior;
- concurrency behavior where applicable;
- tenant-isolation checks; and
- proof that every generated journal entry balances.

## Pull requests

Keep pull requests focused. Describe:

- the user or accounting problem;
- the accounting treatment and affected invariants;
- schema and migration impact;
- permission, audit, and feature-gate impact;
- rollback or operational considerations; and
- the exact checks performed.

By contributing, you agree that your contribution is licensed under the
repository's GNU Affero General Public License v3.0 or later.
