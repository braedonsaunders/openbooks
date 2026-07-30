# Changelog

OpenBooks follows [Semantic Versioning](https://semver.org/) while the public API
and deployment format stabilize. Alpha releases may contain breaking changes;
each release will document required operator action.

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

- 826 release-suite tests passing with no failures or skips at release
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
