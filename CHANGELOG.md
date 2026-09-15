# Changelog

OpenBooks follows [Semantic Versioning](https://semver.org/) while its public
API and deployment format stabilize. Alpha releases may contain breaking
changes; each release documents required operator action.

## [Unreleased]

### Integrations

- Chargebee settlement imports now receipt what was actually collected.
  `amount_paid` is the booked receipt, `amount_adjusted` posts as its own
  adjustment line against the customer (carrying the provider's reason when
  the export surfaces one) instead of being silently dropped, and the import
  refuses to post when the provider total does not foot to amount paid plus
  adjustments plus applied credits — naming the invoice rather than booking
  an unreconciled receipt. Adjustments are tracked apart from refunds in
  batch totals and post as their own clearing line. Schema gains
  `psp_settlement_batches.adjustment_amount` and the `adjustment` settlement
  line kind (migration 0144, additive).

### Scheduler topology

- Scheduled work now runs in the worker process only (`npm run worker`, the
  `worker` Compose service / worker Deployment). The web process no longer
  starts the scheduler unless `OPENBOOKS_RUN_SCHEDULER=1` is set explicitly
  (single-process installs), and never under `next dev`
  (`OPENBOOKS_RUN_SCHEDULER=force` is the only development override). Each
  process logs one `[scheduler]` line at boot stating which mode it is in.
  Concurrent worker replicas still run each tick once via the existing
  Postgres claim lock. No job semantics changed.

### Operator action

- Scheduler topology: multi-process deployments take no action — keep the
  worker service running (it already runs in `compose.yaml` and the HA
  reference). Single-process installs that run web without a worker: set
  `OPENBOOKS_RUN_SCHEDULER=1` on web.

## [0.1.0-alpha.5] - 2026-09-15

A hardening release. A multi-agent audit read the engine, API, and application
layers end to end and shipped about 350 atomic defect fixes, each with a
regression test that failed before the fix and passes after it. No feature
work is included. Operator action: none beyond the normal migration step; the
three payroll migrations below are additive.

### Financial integrity

- Posting: source corrections can no longer over-apply live settlements;
  negative-total credit memos and vendor credits are refused at the posting
  boundary; FX spot lookups break direct/inverse ties deterministically; line
  accounts and parties are checked against the tenant and subsidiary before
  any write; the vendor-payment "total is the cash amount" contract is pinned.
- Payments and receipts: allocation totals use exact money everywhere the UI
  or engine summed them; provider over-collection stays on account instead of
  being dropped; early-payment discounts are vendor-only; settlement evidence
  is scoped to the run's bank account; CPA-005, NACHA and SEPA writers refuse
  blank, oversized or checksum-invalid account and creditor identifiers.
- Banking: Plaid pending authorizations are no longer imported as statement
  truth; GoCardless and CAMT.053 lines are keyed by provider-unique ids;
  inactive reconciliation rules cannot be applied; SFTP statements are parsed
  from exact bytes.
- Payroll: signed stub lines net the deduction-protection base; WCB and
  employer QPIP caps consume committed stubs only; staleness watches pay
  schedules, statutory rates and union fringes; US state withholding engines
  receive YTD supplemental wages and current federal tax; RL-1 slips carry
  opening YTD; Quebec-only remittances use the Revenu Quebec calendar; SINs
  are Luhn-checked on T4/RL-1 transmission; bank-file generation re-verifies
  approval inside its transaction; opening balances now carry second-order YTD
  history and capped employer levies (migrations 0141 and 0143); retro
  readiness compares against a persisted quantification snapshot (0142).
- Tax: taxable-base return boxes convert at the posted FX rate; MACRS pool
  runs refuse short-year factors; nexus rates compare at ledger scale;
  provision reconciliation percents round half away from zero; filing boxes
  keep exact decimals; 1099 thresholds and box rules follow the IRS
  instructions (fishing boat proceeds, OBBBA 2026 threshold, corporate boxes).
- Consolidation and FX: proportionate interests are eliminated; source-to-
  elimination rate pairs are derived; test FX syncs no longer move the
  production schedule cursor.
- Reports and analytics: quarter breakouts follow the organization's fiscal
  start month; cash-basis drill-downs tie to settlement-share recognition;
  utilization and true-cost bases count approved time only; project margins
  scale identically in tables and exports; CSV exports keep exact decimals;
  cockpit tiles are scoped to the primary book and visible subsidiaries and
  translate mixed-currency totals.

### Isolation, authorization, and audit

- Subsidiary scope is enforced on budgets, journals, timesheets, approvals,
  flows, custom records, file-cabinet folders, parties, assistant and MCP
  tools, payroll run populations, and every module cockpit that read past it.
- Feature gates for field tickets, WIP billing, work breakdown and project
  scheduling are enforced in services, not only in navigation.
- Configuration saves (close policy, automation, calendars, reporting
  packages, sandbox schedules), timesheet decisions, and approval gate
  decisions write actor-attributed before/after audit evidence.
- Sealed tax identifiers are omitted from directory payloads; sandbox clones
  scrub masked custom data and users and rebuild derived aggregates.

### API contracts

- Malformed ids answer 404 on every verb instead of surfacing database errors;
  PATCH and DELETE validate what POST validates (dates, booleans, enums,
  referenced ids, custom fields on partial updates); document edits and voids
  carry the exact revision token so stale writes are refused.

### Sync

- Open-item verification compares expense reports alongside invoices, bills
  and credits (the NetSuite mirror had failed the financial gate on a clean
  ledger since the previous release); QuickBooks report dates are normalized
  at the adapter boundary; realized-FX groups get their own entry numbers;
  master-data upserts type their JSON parameters; tax-rate mirrors touch only
  the open current window.

### Test infrastructure

- Test fixtures refuse databases that do not carry the ephemeral marker, so a
  stray test run cannot write to a real database.

### Payroll

- Remittance bills for Revenu Québec destinations are now due on Revenu
  Québec's own timetable. The Canada pack declares the RQ schedule
  (quarterly, monthly, or twice-monthly by average monthly remittance, per
  Guide TP-1015.G and form TPZ-1015.R): Québec income tax, QPP, and QPIP bills
  carry RQ due dates and rules instead of inheriting the filing account's CRA
  remitter type, which previously stamped CRA accelerated-threshold dates on
  RQ bills. Set the frequency from your Revenu Québec notice under Setup →
  Payroll (new employers remit monthly, the default); Setup readiness warns
  while it is unconfirmed and when last year's average points at another band.

## [0.1.0-alpha.4] - 2026-08-20

### Time and timesheets

- Timesheet weeks have a lifecycle. Approved time stays read-only, but a week
  can be reopened while nothing downstream has consumed its hours; the reasons
  it cannot be (invoiced, paid, costed) are named rather than implied. Weeks
  carry their own record, with rejection reasons and amendment links.
- Whether hours require approval before they can be billed or paid is now
  organization policy rather than an assumption, and approval routing runs
  through flows, so approver, order, and quorum are configuration.

### Payments

- Fixed: the NACHA and SEPA direct-debit writers accepted a half-configured
  originator. They checked only that each required field was non-empty, while
  the credit rails additionally reject unfinished `FILL-ME` placeholders and an
  ODFI routing number that is not exactly nine digits. Because the writer
  slices that number to eight characters, an over-long value produced a
  well-formed file addressed to the wrong originating institution. Both debit
  rails now parse their originator to the same standard as the credit rails.

### Integrations

- NetSuite accounts can map their own job billing types instead of inheriting a
  single tenant-wide convention.

### Internal

- Raw SQL now carries its row type as a type argument (`db.execute<Row>(…)`)
  instead of asserting the shape back afterwards. 2,381 laundering casts across
  504 files were removed, along with a dozen ad-hoc "anything with `.execute`"
  parameter types that discarded the row type at the boundary; they share one
  `SqlExecutor` seam. Type-level only — no runtime behaviour changed.

### Operator action

- None. The schema gains `timesheet_weeks` plus two nullable columns on time
  entries; existing weeks derive their state on first use.

## [0.1.0-alpha.3] - 2026-08-04

The first public community preview of OpenBooks.

### Accounting and operations

- PostgreSQL-enforced double-entry ledger, exact decimal money arithmetic,
  periods and close controls, audit evidence, receivables, payables, payments,
  banking, reconciliation, budgets, tax workpapers, and income-tax provisions
- Multi-currency, multi-book, multi-subsidiary, intercompany, consolidation,
  eliminations, non-controlling interest, and goodwill configuration
- Inventory costing and reconciliation, fixed assets and tax pools, project
  accounting, time and job costing, construction progress billing, retainage,
  change orders, and project revenue recognition
- Configurable transaction approvals and workflows, reports and analytics,
  saved searches, exports, custom fields and records, scripts, apps, API keys,
  backups, sandboxes, and optional AI assistance

### First-run experience

- Adaptive company setup that uses industry, size, entity structure, currency,
  operational complexity, and control requirements to shape the workspace
- Three progressive operating profiles—Essentials, Growing, and Advanced—with
  authoritative feature gates that remain fully adjustable in Company Settings
- Go-live readiness guidance from company identity and fiscal calendar through
  opening balances, controls, and first month-end close
- RLS-isolated industry sample-company imports for evaluation and training
- Maintained country tax packs for Canada, the United States, Australia, New
  Zealand, the United Kingdom, Germany, France, Spain, Italy, the Netherlands,
  Ireland, Singapore, India, South Africa, the UAE, and Japan

### Data, integrations, and platform

- Generic migration and mirror framework with adapter-scoped source identities
  for NetSuite, QuickBooks, Xero, ERPNext, Odoo, and Microsoft Dynamics
- Governed tenant-scoped query console with schema browsing, contextual table
  actions, and access only through reviewed reporting views
- Platform controls for apps, scripts, API documentation and keys, MCP, query
  tools, workflows, sandboxes, and AI features
- English, French, Spanish, German, Brazilian Portuguese, Chinese, and Japanese
  locale catalogs

### Deployment, security, and integrity

- One-command Docker Compose installation using separate database-owner and
  constrained runtime roles, generated secrets, health checks, MinIO, Redis,
  web, worker, and migration-first startup
- Multi-platform GHCR image built once, scanned at the exact digest, retagged
  without rebuilding, and published with provenance attestation
- One audited canonical PostgreSQL baseline for clean installations, plus
  release tests for row-level security, source identity, setup provisioning,
  accounting invariants, and documented claims
- Production startup rejection of database roles that can bypass tenant RLS;
  tenant context is enforced across APIs, integrations, scripts, query tools,
  and background jobs
- Product-neutrality, history-hygiene, secret, dependency, container, and
  workflow checks in the release and security pipelines

### Known limitations

- This is alpha software and has not completed an independent accounting audit,
  security audit, or broad production validation. Start with test or parallel
  books and reconcile all opening balances, tax treatment, permissions,
  reports, backups, and jurisdiction-specific requirements.
- Country packs provide maintained configuration, workpapers, and exports; they
  are not universal electronic-filing certification or professional tax advice.
- The included Compose deployment is a single-host installation. A separate HA
  application-tier reference is provided, but operators remain responsible for
  production-grade database, cache, object-storage, ingress, monitoring,
  backup, and recovery infrastructure.

### Operator action

- Fresh installations bootstrap directly from the canonical baseline.
- Keep the generated `.env.compose` file secure and back it up; it contains the
  first administrator login and deployment secrets.
- Before using OpenBooks as a system of record, complete a restore rehearsal and
  the validation steps in the upgrade and backup runbooks.

[0.1.0-alpha.4]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.3
