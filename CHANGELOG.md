# Changelog

OpenBooks follows [Semantic Versioning](https://semver.org/) while its public
API and deployment format stabilize. Alpha releases may contain breaking
changes; each release documents required operator action.

## [Unreleased]

## [0.1.0-alpha.6] - 2026-09-15

Defect-remediation release: ~300 atomic fixes from a third audit fleet
(persona attacks, real-data replay, mutation survivors, standards
conformance, boundary sweeps), each with a red-then-green regression test
and an independent review. Highlights below; every commit carries its own
defect / root cause / fix / verification record.

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

### Analytics

- Analytics: True Cost dashboard restored as a hub dashboard; the report
  remains at /reports/true-cost.

### Operator action

- Scheduler topology: multi-process deployments take no action — keep the
  worker service running (it already runs in `compose.yaml` and the HA
  reference). Single-process installs that run web without a worker: set
  `OPENBOOKS_RUN_SCHEDULER=1` on web.

### Ledger and close

- Posted journal entries can no longer be flipped back to draft through the
  kernel guard (migration 0146, `je_guard` v3: posted exits only to
  reversed). Tax amounts without calculation evidence fail closed instead of
  silently dropping at posting. Account-parent cycles no longer hang every
  statement. Direct inventory postings stamp the GL location dimension.
- Close readiness scopes the posting-period check to the run period, goes red
  on unrecognized deferred revenue, and re-publishing after a reopen versions
  the binder (original retained, restatement note required). Consolidation,
  elimination, lease, asset and FX-revaluation writes into closed periods
  refuse with named errors instead of raw storage failures. Depreciation
  catches up skipped months and allocates 4-4-5 calendars; secondary books
  revalue; asset disposal refuses while a begun stub period is unposted.
- New admin remediation paths: bulk assign-posting-period from the readiness
  blocker, and duplicate-project detection with an audited merge.

### Cash, receivables and payables

- Open items net unapplied credit memos (cash forecast, cash position,
  vitals and assistant tools now tie to aging to the cent); as-of agings and
  forecasts reconstruct settlement timing instead of reading live balances;
  day-90 items age into the 90+ bucket; quiet parties keep their balance on
  statements. Consolidated open items, bank balances, cockpit tiles and the
  analytics hubs translate every functional currency to the presentation
  currency at the correct spot and fail closed on missing rates.
- Ad-hoc vendor payments honour subcontractor compliance blocks. Early-payment
  discounts round to the bill currency's minor units. Refund-first PSP
  webhooks park as pending clawbacks and settle exactly once (migration
  0149). Void versus application races no longer deadlock.

### Tax, payroll and standards

- GST34 packs installed by the pre-split seed are healed to the collected /
  paid / taxable bases (migration 0147; a real tenant filed net tax at double
  the true amount). Codeless source tax is refused upstream with the source
  reference. The payroll remittance summary survives a run with an unknown
  filing account and statutory payable remappings return a typed warning.
- Conformance matrix republished at 75 passing cases and 15 declared gaps
  (partial disposal, intercompany asset transfer, lease early termination,
  4-4-5 depreciation, partial disassembly, loss of control, …).

### Integrity, contracts and concurrency

- Reference ownership is fenced on every write path (records API, documents
  and lines, journals, expenses, items, parties, assets, timesheets, rate
  cards, property, custom records, scripts, Flows actions and imports):
  foreign-org ids are refused with tenant-opaque 404s instead of storage
  errors. Dozens of routes refuse magnitudes wider than their numeric columns
  and dates that are not real calendar days with typed 4xx responses.
- Revision tokens on prebill lines, AP-capture reviews, custom records and
  opportunities; compare-and-swap on percent-complete overrides; sorted
  advisory locks for inventory reversals; repeatable-read sandbox clones with
  per-sandbox refresh serialization; sandboxes holding posted documents can
  be created, refreshed and deleted (migration 0148). Audit rows now carry
  actor and before/after for the v1 writer, imports, Flows mutations,
  pay-run commits and mirror-posted documents.
- The approvals worklist and the pending-approvals count unify Flows gates,
  document-status approvals and pay runs. KPI definitions are single-sourced
  (DSO across all six surfaces). Paginated lists carry a unique tiebreaker and
  malformed filters fail closed to empty. Budget vs actual and the dashboard
  cash tile bind to the resolved period.

### Imports and integrations

- Every registered data resource round-trips export → import into a fresh
  org and re-imports idempotently (matrix test committed). Settlement links
  state their currency on all six connectors and the reconciler converts or
  refuses. Source subsidiary functional-currency changes are held for review.
  The QuickBooks Desktop Web Connector SOAP route is reachable through the
  edge and password guessing is bounded.

### Dashboard

- Saving Quick Actions on a never-customized dashboard no longer wipes the
  widget grid; malformed or empty stored layouts fall back to the default and
  self-heal on the next view. The greeting follows the viewer's clock.
- Performance: the indirect cash flow's outer scans are bounded by the window
  (138 s → ~10 s on a multi-million-line tenant); capped detail exports
  disclose the cap in every format.

### Operator action

- Migrations 0146–0149 apply automatically on deploy (forward-only,
  idempotent). 0147 rewrites installed CA_GST34 pack rows for lines 101 /
  103 / 106 on every org that installed the pre-split seed; re-run affected
  returns after upgrading.

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
