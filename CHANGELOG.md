# Changelog

OpenBooks follows [Semantic Versioning](https://semver.org/) while the public API
and deployment format stabilize. Alpha releases may contain breaking changes;
each release will document required operator action.

## [0.1.0-alpha.3] - 2026-08-04

### Added

- Explicit company provisioning for feature defaults, customization, project
  types, payment operations, CRM, and close configuration
- Adapter-scoped source identities for generic, collision-safe migration and
  mirror connectors
- Database-backed release tests for row-level security, canonical schema
  controls, source identity, setup provisioning, and README claims

### Changed

- Replaced the prerelease generated migration chain with one audited canonical
  PostgreSQL baseline for clean installations
- Made setup pages and GET endpoints read-only; provisioning now happens only
  through bootstrap or explicit setup commands
- Removed tenant-specific migration and reconciliation operators from the
  public product while preserving the generic connector framework
- Removed accounting currency fallbacks and historical repair behavior from
  ordinary runtime paths

### Security and integrity

- Test-only database bypass now requires an explicit trusted test flag and is
  rejected in production
- Generic source identity uniqueness is enforced independently for every
  organization and connector system
- Product-neutrality checks now reject private tenant identifiers, incident
  references, and operator artifacts in tracked or publishable files

### Operator action

- Fresh installs bootstrap directly from the canonical baseline.
- Back up any earlier alpha database before upgrading. Because this is a
  prerelease baseline reset, existing alpha installations require an
  operator-reviewed catalog adoption or a fresh database; startup refuses to
  guess through a migration digest mismatch.

## [0.1.0-alpha.2] - 2026-08-01

### Added

- Adaptive first-run company setup and go-live readiness guidance, with a
  multi-question operating profile and authoritative Company Settings feature
  gates
- Audited, RLS-isolated industry sample-company templates and one-click preview
  imports
- Maintained country tax packs for Canada, the United States, Australia, New
  Zealand, the United Kingdom, Germany, France, Spain, Italy, the Netherlands,
  Ireland, Singapore, India, South Africa, the UAE, and Japan
- Governed tenant-scoped query console with schema browsing and table context
  actions
- Platform settings for apps, scripts, API keys, API documentation, MCP, query
  tools, workflows, sandboxes, and optional AI assistance

### Changed

- Replaced pre-launch compatibility fields and fallback models with canonical
  project, close, reporting, bank-rule, custom-record, and period identities
- Moved construction payment applications into normal project billing workflows
- Made journal approvals use the same configurable Flow lifecycle as other
  transactions
- Upgraded to Next.js 16.2.12 and Drizzle 1.0.0-rc.4
- Hardened the Docker Compose installer with separate database-owner and runtime
  roles, explicit country/currency selection, health checks, and migration-first
  startup

### Security and integrity

- Added production startup checks that reject database roles capable of
  bypassing tenant RLS
- Enforced tenant context across sample data, query tooling, application APIs,
  scripting, integrations, and background workers
- Added atomic/idempotent posting and payment operations, effective-dated tax
  provisioning, and exact period identity controls

### Operator action

- Back up the database before upgrading. The container bootstrap applies all
  tracked migrations before web and worker services start.
- Deploy the web and worker processes from the same `v0.1.0-alpha.2` image. This
  release removes pre-launch compatibility columns and requires schema and code
  to move together.

## [0.1.0-alpha.1] - 2026-07-30

First packaged community release.

### Included

- PostgreSQL-enforced double-entry accounting kernel, exact money arithmetic,
  organization row-level security, audit evidence, and period controls
- General ledger, receivables, payables, payments, banking, reconciliation,
  budgets, close, tax workpapers, and income-tax provisions
- Multi-currency, multi-book, multi-subsidiary, intercompany, ownership
  consolidation, eliminations, NCI, and goodwill configuration
- Inventory subledger with FIFO, moving average, standard cost, landed costs,
  lot/serial tracking, and GL reconciliation
- Fixed assets, alternate depreciation books, tax pools, remeasurement,
  impairment, disposal, and exact correction lineage
- Projects, time, job costing, labor pricing, construction progress billing,
  schedules of values, pay applications, retainage, change orders, field
  tickets, subcontractor compliance, and project revenue recognition
- CRM, orders, subscriptions, dunning, hosted payment links, PSP settlements,
  and revenue-recognition schedules
- Reports, analytics, saved searches, PDF/Excel/CSV export, SQL workbench,
  custom fields/records/forms, JavaScript scripting, apps, workflows, API keys,
  backups, sandboxes, and optional AI assistance
- Migration tooling for NetSuite, QuickBooks Online, QuickBooks Desktop, Xero,
  ERPNext, Odoo, and Microsoft Dynamics
- English, French, Spanish, German, Brazilian Portuguese, Chinese, and Japanese
  locale catalogs
- Multi-platform GHCR image and self-contained Docker Compose installation
- Formal first-run company setup with audited completion/deferral, industry
  chart-of-accounts presets, authoritative feature dependencies, and a permanent
  resume path in Company Settings

### Verification

- Release-suite unit and database integration tests passing at release
  preparation
- PostgreSQL-backed integration canary and full integration suite in CI
- Playwright browser smoke suite
- Release workflow typecheck, test, production build, multi-platform image
  build, and image provenance attestation

### Known limitations

- Alpha software without independent accounting or security certification
- No complete payroll/HCM, manufacturing/MRP, POS, e-commerce, native mobile,
  or offline-first module
- Tax packs are configurable workpapers and exports, not universal direct
  electronic-filing certification
- First-party MFA and SAML/OIDC SSO are not yet included

[0.1.0-alpha.1]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.2]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.3]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.3
