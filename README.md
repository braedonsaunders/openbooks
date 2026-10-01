<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/openbooks-logo-dark.svg" />
    <img src=".github/assets/openbooks-logo.svg" alt="OpenBooks" width="440" />
  </picture>
</p>

<p align="center">
  <strong>The open business suite. Run on open books.</strong><br />
  Accounting and ERP for businesses of every size, across industries—from
  solo operators and small teams to large, multi-entity organizations.<br />
  Start with everyday bookkeeping; add connected operations and project
  workflows as you grow.<br />
  Open source, self-hosted, and built around a PostgreSQL-enforced double-entry
  ledger.
</p>

<p align="center">
  <a href="https://github.com/braedonsaunders/openbooks/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/braedonsaunders/openbooks/actions/workflows/test.yml/badge.svg" /></a>
  <a href="https://github.com/braedonsaunders/openbooks/releases"><img alt="Release" src="https://img.shields.io/github/v/release/braedonsaunders/openbooks?include_prereleases&color=0f766e" /></a>
  <a href="https://github.com/braedonsaunders/openbooks/pkgs/container/openbooks"><img alt="Container" src="https://img.shields.io/badge/GHCR-multi--arch-2496ED?logo=docker&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/License-AGPL--3.0--or--later-0f766e" /></a>
  <img alt="Alpha software" src="https://img.shields.io/badge/status-alpha-f59e0b" />
</p>

<p align="center">
  <a href="#run-it">Install with Docker</a> ·
  <a href="#see-openbooks-in-action">Screenshots</a> ·
  <a href="#what-is-implemented">Features</a> ·
  <a href="#accounting-kernel">Accounting kernel</a> ·
  <a href="TRUST.md">Trust</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#project-status">Status</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <img src=".github/codeflow-card.svg" alt="CodeFlow card—codebase scale and structure snapshot" width="100%" />
</p>

---

## Your books. Your server. Your roadmap.

**An invoice should connect to your projects, inventory, cash and financial
statements. Your ERP should connect to the way your business works.**

OpenBooks brings accounting, operations and people into one open-source business
suite. Start with customers, invoices, expenses and your books when you work
solo. Add purchasing, inventory, projects and payroll as your team grows. For
larger organizations, connect legal entities, currencies, approvals and
consolidated reporting in the same suite.

Follow a number from a dashboard to its report, source document and journal.
Choose the capabilities that fit your business in Company Settings → Features,
with one connected system underneath.

Self-host it. Inspect the financial logic. Extend the workflows. Add users and
companies without per-seat software licence tiers. Your infrastructure and
operating costs remain yours; the software is AGPL-3.0-or-later.

**Start with a sample company, explore the workflows, then evaluate it with
parallel books.** OpenBooks is alpha software with a broad implementation and
explicit accounting controls. It has not completed independent accounting or
security certification. That distinction matters when choosing financial software.

## Run it

### Install the prebuilt Docker image (recommended)

Use [Docker with Compose](https://docs.docker.com/compose/install/) and `curl` in
a Linux, macOS or Windows WSL2 terminal. Download the two deployment files below;
the installer pulls the [published OpenBooks image](https://github.com/braedonsaunders/openbooks/pkgs/container/openbooks)
and runs it with its supporting services.

```bash
mkdir -p openbooks/scripts
cd openbooks
openbooks_deployment="https://raw.githubusercontent.com/braedonsaunders/openbooks/350252fc633149c572a7d7257f6ef8043d00c018"
curl -fL "$openbooks_deployment/compose.yaml" -o compose.yaml &&
curl -fL "$openbooks_deployment/scripts/compose-up.sh" -o scripts/compose-up.sh &&
sh ./scripts/compose-up.sh
```

The deployment files above are pinned to a specific revision. Application
services use the official release image, pinned by the installer to its immutable
digest. For source builds and local development, see [Development](#development).

Choose your organization's ISO country and base currency when prompted. The
installer generates credentials, resolves the official release to an immutable
image digest, starts the services, applies migrations, and prints the URL and
first administrator login after health checks pass. Installation time depends
on your connection and machine.

**Open <http://localhost:4780>.** Sign in with the printed credentials and follow
the company setup wizard: identity, fiscal calendar, chart of accounts and
features. You can defer setup and resume it from Company Settings. Enable the
modules you need in **Company Settings → Features**.

For an unattended first install:

```bash
ORG_COUNTRY=US ORG_CURRENCY=USD sh ./scripts/compose-up.sh
```

The deployment includes PostgreSQL 16, Redis 7, MinIO, the web app and a separate
background worker. Bootstrap provisions separate database roles for migrations,
tenant requests and installation-wide maintenance. Generated secrets stay in
`.env.compose`, created with owner-only permissions. Keep that file private and
back it up securely.

### A first session that shows how it fits together

1. Finish company setup and explore the built-in sample-company options in Data
   → Import. Use synthetic data for evaluation.
2. Open the dashboard and drill into a profit and loss statement.
3. Review a customer invoice, its journal and related project activity.
4. Explore purchasing, inventory, approvals and audit history.
5. Before importing real balances, validate your chart, currencies, tax and
   payroll scope, posting rules, permissions and opening-balance reconciliation.

### Keep your evaluation easy to operate

```bash
# Service status and worker health
docker compose --env-file .env.compose ps
curl 'http://localhost:4780/api/v1/health?include=worker'

# Follow application and worker activity
docker compose --env-file .env.compose logs -f web worker

# Stop while preserving the named data volumes
docker compose --env-file .env.compose down
```

`down -v` deletes the data volumes. Treat upgrades as reviewed releases:
[upgrade runbook](docs/operations/upgrades.md). Before exposing an installation,
configure TLS, backups, monitoring, email and secret management using
[SECURITY.md](SECURITY.md) and the [backup/restore runbook](docs/operations/backup-restore.md).
Compose runs on one host; [the HA reference](deploy/ha) describes separately
operated infrastructure for a replicated application tier.

## See OpenBooks in action

<p align="center">
  <img src=".github/assets/screenshots/financial-health.jpg" alt="OpenBooks financial health dashboard showing score, KPIs, trends, issues, recommendations, and a profit and loss summary" width="100%" />
</p>
<p align="center"><sub>Move from headline performance to trends, exceptions, recommendations, and the underlying financial statements in one workspace.</sub></p>

<table>
  <tr>
    <td width="50%">
      <img src=".github/assets/screenshots/executive-dashboard.jpg" alt="OpenBooks personalized dashboard showing cash, receivables, payables, quick actions, approvals, and recent journal activity" width="100%" /><br />
      <sub><strong>Personalized workspace:</strong> Cash, receivables, payables, quick actions, approvals, and recent accounting activity.</sub>
    </td>
    <td width="50%">
      <img src=".github/assets/screenshots/profit-and-loss.jpg" alt="OpenBooks profit and loss statement for Summit Ridge Construction" width="100%" /><br />
      <sub><strong>Financial reporting:</strong> Drillable statements with dimensions, saved views, comparisons, and exports.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src=".github/assets/screenshots/project-profitability.jpg" alt="OpenBooks project profitability report grouped by customer and job" width="100%" /><br />
      <sub><strong>Project profitability:</strong> Revenue, cost, margin, profit, and hours from customer down to job.</sub>
    </td>
    <td width="50%">
      <img src=".github/assets/screenshots/project-financials.jpg" alt="OpenBooks project financial cockpit showing job price, invoicing, costs, and gross profit" width="100%" /><br />
      <sub><strong>Project cockpit:</strong> Contract value, billable balance, actual and committed costs, and gross profit.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src=".github/assets/screenshots/construction-billing.jpg" alt="OpenBooks construction progress billing with schedule of values and retainage" width="100%" /><br />
      <sub><strong>Project billing:</strong> Applications, schedules of values, change orders, and retainage stay inside the project record.</sub>
    </td>
    <td width="50%">
      <img src=".github/assets/screenshots/application-invoice.jpg" alt="OpenBooks customer invoice created from an application for payment" width="100%" /><br />
      <sub><strong>Connected invoices:</strong> Approved applications become regular customer invoices with project, line, posting, and audit context.</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Light mode is shown above. Screenshots use the built-in synthetic Summit Ridge Construction demo; no customer data is shown.</sub></p>

<details>
<summary><strong>Prefer dark mode?</strong> View the same workflows in OpenBooks dark mode.</summary>
<br />
<p align="center">
  <img src=".github/assets/screenshots/financial-health-dark.jpg" alt="OpenBooks financial health dashboard in dark mode" width="100%" />
</p>
<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/executive-dashboard-dark.jpg" alt="OpenBooks personalized dashboard in dark mode" width="100%" /></td>
    <td width="50%"><img src=".github/assets/screenshots/profit-and-loss-dark.jpg" alt="OpenBooks profit and loss statement in dark mode" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/project-profitability-dark.jpg" alt="OpenBooks project profitability report in dark mode" width="100%" /></td>
    <td width="50%"><img src=".github/assets/screenshots/project-financials-dark.jpg" alt="OpenBooks project financial cockpit in dark mode" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/construction-billing-dark.jpg" alt="OpenBooks project-contained application billing in dark mode" width="100%" /></td>
    <td width="50%"><img src=".github/assets/screenshots/application-invoice-dark.jpg" alt="OpenBooks customer invoice created from an application for payment in dark mode" width="100%" /></td>
  </tr>
</table>
</details>

## What is implemented

OpenBooks is accounting-first, with connected operating modules. Optional
features are controlled through the single Company Settings switchboard.
Capabilities below describe code in the repository; they are not a promise that
every business or jurisdiction is ready to adopt without validation.

| Your work | Connected capabilities |
| --- | --- |
| **Accounting and close** | Double-entry journals, chart of accounts, dimensions, budgets, open items, controlled reversals/corrections, close tasks, approvals, period locks and controlled reopen |
| **Sales and receivables** | Quotes, orders, invoices, credits, receipts, returns, customer balances, recurring/usage billing and revenue recognition |
| **Purchasing and payables** | Purchase orders, vendor bills/credits, payments, purchasing controls, expenses and approvals |
| **Banking** | Statements, matching, reconciliation, cash reporting and configurable feeds |
| **Projects and construction** | Job costing, budgets, committed cost, labor rates, profitability, schedules of values, change orders, progress applications and retainage |
| **Inventory and manufacturing** | Stock, locations, costing, landed cost, inventory/GL reconciliation, bills of materials, routings, MRP, work orders, material movements and production completion |
| **Assets and equipment** | Registers, depreciation methods/books, impairment, remeasurement, disposal and controlled corrections |
| **Multiple entities and currencies** | Legal entities, accounting books, intercompany, eliminations, FX evidence/revaluation, ownership-based consolidation and consolidated reporting |
| **People and payroll** | Employee records, recruitment, onboarding, performance, benefits enrolment, self-service, time/leave, pay-run readiness, statutory calculations, remittances and declared filing exports |
| **Tax** | Tax configuration, jurisdiction-specific workpapers, return mappings and income-tax provisions; filing availability varies by pack |
| **Specialized operations** | Nonprofit funds, gifts, grants, pledges and restrictions; property leases and CAM workflows; subscription billing and SaaS metrics |
| **Reporting and automation** | Shared report engine, period/dimension filters, saved views, drill-through, exports, dashboards, approvals, scheduled jobs and sandboxed extensions |

Manufacturing is broader than light assembly: routings, planning and production
workflows are implemented. Evaluate capacity planning, shop-floor workflows,
traceability and industry requirements against your actual operation before
adopting it as a manufacturing system.

### Localization you can inspect

Payroll packs are registered for AU, BR, CA, DE, ES, FR, GB, IE, IT, JP, NL, PL,
SG and US. **A country name is not a universal compliance claim.** Loaded tax
years, regional calculations, required employer/employee inputs, filing formats,
corrections and remittance schedules have distinct scopes.

Generate the source-labelled capability inventory with:

```bash
npm ci
node --import tsx scripts/localization-support-scope.ts > localization-support.json
```

The inventory comes from the calculation and filing declarations, including
named refusals. It distinguishes implementation from agency acceptance and
marks an uncommitted workspace explicitly. Follow the
[localization adoption guide](docs/operations/localization.md) before statutory use.
The interface has English, German, Spanish, French, Japanese, Brazilian Portuguese
and Chinese message catalogs; statutory coverage is independent of interface language.

### Honest limits

OpenBooks remains alpha. It does not claim universal statutory coverage,
certified agency submission, SOC 2, ISO 27001, PCI DSS, or independent accounting
and security audits. It has no native iOS/Android app or general offline-first
client. Benefits-carrier/job-board integrations, POS and storefront requirements
need separate evaluation. Self-hosting means owning deployment, backups,
upgrades and operational support.

## Accounting kernel

The ledger is the foundation, rather than a reporting calculation applied after
the fact. PostgreSQL controls protect balanced journals and period rules; exact
decimal and BigInt helpers handle money. Posted history is corrected through
controlled reversal and adjustment workflows. Source documents, open items,
subledgers and audit evidence connect to the journal.

Financial features use organization and legal-entity scope, explicit permissions,
lifecycle transitions, concurrency controls and effective-dated configuration.
Feature changes preserve historical data. These mechanisms are engineering
controls whose implementation and tested scope can be inspected.

**Posted journal and completed downstream processing are separate states.** The
shared document drawer shows queued, running, retrying, terminal-failed or
completed posting effects. An authorized operator can retry a terminal failure
with a recorded review reason. Incomplete effects appear in close readiness and
block hard GL close for the affected scope. See the
[posting-effects runbook](docs/operations/posting-effects.md).

### Verify the source and the execution

Read [TRUST.md](TRUST.md), the [standards matrix](docs/trust/conformance-matrix.md)
and [control matrix](AUDIT-CONTROLS.md) for the assertions and scenarios measured.
Tests do not substitute for an independent audit or prove every accounting rule.

The trust pipeline requires standards, internal controls, a nonempty successful
ledger checkpoint and a complete workflow execution receipt to identify the
**same full commit**. The receipt names every required unit, database, browser,
simulation and restore partition. The published bundle includes component
SHA-256 digests and append-only publication history. Missing, skipped, failed or
mixed-source evidence refuses publication.

Historical checked-in reports retain their own provenance. A green workflow
badge or a focused test run does not establish that the entire current tree has
passed. Comprehensive verification remains an explicitly dispatched workflow;
independent payroll browser workflows have their own scope.

## Architecture

A TypeScript monorepo with a Next.js application, bounded domain engine,
PostgreSQL accounting kernel and shared packages. Engine module dependencies
form an enforced acyclic graph; application adapters use named package contracts
for new integrations. Shared lists, reports, drawers, setup, printing and email
keep modules consistent.

| Layer | Implementation |
| --- | --- |
| Runtime | Node.js 24 |
| Web | Next.js 16.3, React 19, Tailwind CSS 4 |
| Language | TypeScript 6.0 workspace toolchain |
| Data | PostgreSQL 16, Drizzle ORM, SQL controls and forward migrations |
| Background work | Redis 7, BullMQ and a separate worker |
| Files | S3-compatible storage; MinIO in Compose |
| Money | PostgreSQL numeric values and exact BigInt decimal helpers |
| Extensions | QuickJS sandbox, native configuration and workflow machinery |

See [engine module design](docs/design/engine-modules.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) for boundaries and development conventions.

## Development

Use Node.js 24 and the repository's npm lockfile. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for local environment and database setup.

```bash
npm ci
npm run check:engine-boundaries
npm run check:engine-public-api
```

Keep test databases isolated from financial data. Unit, integration, browser and
restore checks have separate owners and requirements; never interpret skipped
database tests as completed verification. Schema changes use forward migrations.

## Project status

OpenBooks is actively developed alpha software. Start with an evaluation
installation and representative workflows. Before production adoption, validate
financial policies, reconciliation, jurisdictional obligations, permissions,
backup restoration and the release you intend to operate.

Found a refusal that is unclear, a workflow that breaks, or a number that does
not reconcile? A reproducible issue with synthetic inputs and expected behavior
is particularly useful. See [issues](https://github.com/braedonsaunders/openbooks/issues)
and [contribution guidance](CONTRIBUTING.md).

## Community

If OpenBooks is useful to you, **star the repository and share a workflow you
tried**. Screenshots, clear bug reports, localization evidence, documentation and
code contributions all help the next organization evaluate it honestly.

## License

[AGPL-3.0-or-later](LICENSE). Free to use, inspect and modify under its terms.
If you modify and offer it over a network, the licence's source-availability
requirements apply. Review the licence for your distribution and hosting model.
