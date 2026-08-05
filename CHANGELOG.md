# Changelog

OpenBooks follows [Semantic Versioning](https://semver.org/) while its public
API and deployment format stabilize. Alpha releases may contain breaking
changes; each release documents required operator action.

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

[0.1.0-alpha.3]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.3
