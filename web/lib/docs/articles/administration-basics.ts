import type { DocArticle } from '../types'

export const companySettings: DocArticle = {
  slug: 'company-settings',
  title: 'Company Setup',
  category: 'administration',
  order: 1,
  summary:
    'Use the configuration center for company, accounting, tax, dimensions, billing, revenue, inventory, workforce, assets, and currency.',
  updated: '2026-07-21',
  keywords: [
    'company settings',
    'setup',
    'configuration',
    'tax',
    'dimension',
    'currency',
    'accounting book',
    'number sequence',
  ],
  related: ['quick-start', 'chart-of-accounts-and-dimensions', 'roles-and-permissions'],
  body: `# Company Setup

**Settings → Company Setup** is the tenant-scoped configuration center.
Settings here shape posting, approvals, numbering, reporting, tax, close, and
daily record behavior.

## Configuration areas

The setup rail groups configuration by purpose:

- **Company** — organization identity, subsidiaries, and intercompany structure.
- **Accounting** — books, periods, policies, accounts, and close-related defaults.
- **Taxes** — codes, rates, forms, and filing behavior. Effective-dated rates
  live in each **Tax Code** flyout, while return-box mappings live in each
  **Tax Return** flyout instead of occupying separate setup tabs.
- **Dimensions** — departments, locations, classes, account groups, and related
  analysis structures.
- **Billing and revenue** — terms, sequences, recognition, pricing, and project
  behavior.
- **Inventory, workforce, and assets** — operational and accounting policies for
  those modules.
- **Currency** — currencies, rate types, rates, and consolidation configuration.

The exact tabs available depend on enabled capabilities and permissions.

## Change control

Search for an existing definition before creating one. Use stable codes, clear
names, and descriptions that explain business purpose. Test changes in an open
period with a small transaction and review the generated ledger entry and
reports.

Archiving prevents new selection while preserving historical references. Avoid
changing the meaning of a code that already appears on posted activity.

## Secrets and connections

Integration configuration is per organization and managed through the platform
connection UI. Credentials and tokens are sealed and must not be placed in
ordinary application settings or shared configuration files.

## Documentation and ownership

Assign an owner for each material configuration area and retain approval for
changes that affect accounting. Configuration workspaces link to their detailed
articles as coverage is added to this documentation center.
`,
}

export const rolesAndPermissions: DocArticle = {
  slug: 'roles-and-permissions',
  title: 'Users, Roles, and Permissions',
  category: 'administration',
  order: 2,
  summary: 'Design least-privilege roles, invite users, separate duties, and test effective access.',
  updated: '2026-07-19',
  keywords: ['users', 'roles', 'permissions', 'access', 'least privilege', 'segregation of duties', 'administrator'],
  related: ['company-settings', 'audit-log', 'navigation-and-records'],
  body: `# Users, Roles, and Permissions

Access is organization-scoped and permission-driven. Navigation reflects a
user's effective permissions, but hiding a menu item is not the security
boundary—the server checks permissions on protected reads and mutations.

## Design roles around work

Create roles for stable responsibilities such as AP entry, AP approval, payment
release, AR, accountant, controller, reporting, implementation, and platform
administration. Grant the minimum read and action permissions needed.

Separate incompatible duties where practical:

- creating a vendor from releasing its payment;
- preparing a transaction from approving it;
- running a close from approving or reopening it;
- building an integration from reviewing its results; and
- administering roles from reviewing the audit log.

## Assign users

Invite or create the user, set the appropriate locale, assign roles, and confirm
organization membership. Avoid shared user accounts; individual identity is
required for meaningful audit evidence.

## Test effective access

Use a non-administrator test user for each critical role. Confirm that the user
can find and complete expected work, cannot open restricted records or actions,
and receives a clear error when a direct URL or API request exceeds authority.

## Review regularly

Review active users, role assignments, privileged permissions, dormant access,
and segregation conflicts on a scheduled basis and after job changes. Remove
access promptly when it is no longer needed.

Use the **Audit Log** to review administrative changes. Do not grant wildcard
administrator access merely to work around a missing workflow; correct the role
or underlying permission design.
`,
}

export const dataImports: DocArticle = {
  slug: 'data-imports',
  title: 'Data Imports',
  category: 'administration',
  order: 3,
  summary:
    'Prepare, map, validate, run, and review governed data imports without creating duplicate or orphaned records.',
  updated: '2026-07-19',
  keywords: ['CSV import', 'data import', 'mapping', 'validation', 'import history', 'external id', 'migration'],
  related: ['migration-and-cutover', 'reconciliation-before-cutover', 'audit-log'],
  body: `# Data Imports

Use **Company Setup → Data Import** for supported file-based loads. Import
access is privileged because a single file can create or change many records.

## Prepare the file

Start from a clean export or approved template. Use stable external identifiers,
ISO dates, explicit currencies, and unambiguous decimal amounts. Normalize codes
and remove duplicate headers, totals, blank records, and formula artifacts.

Create referenced configuration and master records first. An imported
transaction should not invent an account, tax code, customer, or dimension
because its mapping was missing.

## Map fields

Map every required source column to its OpenBooks field and review transforms for
status, account, date, currency, tax, and dimension values. Save the source file
and mapping version as migration evidence.

## Validate before writing

Resolve invalid dates, missing references, duplicate keys, unsupported values,
and financial imbalances before the run. Do not weaken validation to make a
source file pass.

## Run and review

After the import, open **Import History** and review counts, diagnostics, creator,
time, and result. Search the target list and inspect representative records.
For financial data, reconcile totals and record-level samples to the source.

## Repeat safely

Prefer stable external IDs and an idempotent process. A retry should update or
recognize the same source records according to the import contract, not create a
second copy. Test the exact repeat behavior before using a file in production.

File import is appropriate for controlled batches. Use a tenant-configured
source connection for repeat synchronization or a specialized historical
capture.
`,
}
