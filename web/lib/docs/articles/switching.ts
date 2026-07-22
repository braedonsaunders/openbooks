import type { DocArticle } from '../types'

export const switchingFromSmallBusinessSystems: DocArticle = {
  slug: 'switching-from-small-business-systems',
  title: 'Switching from a Small Business System',
  category: 'switching',
  order: 1,
  summary:
    'Map familiar lists, forms, bank workflows, reports, and close controls into OpenBooks.',
  updated: '2026-07-21',
  keywords: ['small business', 'migration', 'classes', 'bank feed', 'familiarization'],
  related: ['quick-start', 'banking-and-reconciliation', 'migration-and-cutover'],
  body: `# Switching from a Small Business System

OpenBooks separates business transactions from their ledger entries and adds
deeper configuration, approval, close, and audit controls. Daily sales,
purchasing, and banking concepts remain familiar.

## Familiar concepts

| Source concept | OpenBooks destination |
| --- | --- |
| Customers and vendors | Role-specific views of shared parties |
| Products and services | **Operations → Catalog → Items & Services** |
| Invoices and customer receipts | **Invoices** and **Customer Payments** |
| Bills and supplier payments | **Bills** and **Vendor Payments** |
| Expenses | **Purchasing → Pay → Expenses** |
| Chart of accounts | **Accounting → Chart of Accounts** |
| Classes, locations, or tracking | Configurable dimensions in **Settings → Company Setup** |
| Bank feeds and rules | **Banking → Match** and **Rules** |
| Reconciliation | **Banking → Reconciliations** |
| Closing date | Accounting-period locks and **Period Close** |
| Custom reports | Reports, Saved Views, Analytics, and Dashboards |

## Transactions and posting

Creating a new record makes a persisted draft. Saving or autosaving does not
change the ledger. Approval and posting are explicit actions, and each posted
business transaction produces one balanced journal entry you can inspect.

Use customer receipts, vendor payments, credits, and applications to maintain
open-item detail. Avoid direct journals to receivables or payables control
accounts.

## Dimensions, locations, and projects

Map each source classification according to its actual reporting purpose. A
department should become a department and a location should remain a location.
Use projects for job-level time, cost, billing, and profitability rather than as
a generic tag.

## Bank workflow

Statement lines are external evidence. Match them to existing receipts,
payments, transfers, or journals; categorize only genuine missing activity.
Complete and sign off a reconciliation separately from transaction matching.

## Migration advice

Export the detailed general ledger, trial balance, chart, lists, open invoices
and bills, unapplied cash and credits, reconciliations, tax detail, attachments,
and audit evidence required by policy. Preserve stable source identifiers.

Reconcile account-period activity and open items, then verify dimensions,
parties, projects, tax, and currency detail on representative transactions.
`,
}

export const switchingFromEnterpriseSystems: DocArticle = {
  slug: 'switching-from-enterprise-systems',
  title: 'Switching from an Enterprise System',
  category: 'switching',
  order: 2,
  summary:
    'Map entities, dimensions, subledgers, workflows, reporting, and extensions into OpenBooks.',
  updated: '2026-07-21',
  keywords: ['enterprise', 'migration', 'dimensions', 'subledgers', 'familiarization'],
  related: ['navigation-and-records', 'migration-and-cutover', 'analytics-and-saved-views'],
  body: `# Switching from an Enterprise System

OpenBooks covers the accounting and operations jobs expected from an enterprise
suite without reproducing another product's screens field for field. Start with
the business purpose of each record and use the shared list-and-drawer workflow.

## Familiar concepts

| Source concept | OpenBooks destination |
| --- | --- |
| Legal entities and hierarchies | **Settings → Company Setup → Subsidiaries** |
| Chart of accounts | **Accounting → Chart of Accounts** |
| Departments, classes, and locations | Organization dimensions in **Settings → Company Setup** |
| Customers, vendors, and employees | Role-specific views of shared parties |
| Items and services | **Operations → Catalog → Items & Services** and **Inventory** |
| Business transactions | Sales, Purchases, Banking, and Accounting record drawers |
| Posting periods | **Accounting → Period Close** and accounting-period configuration |
| Saved queries | **Insights → Saved Views** |
| Workflow automation | **Settings → Automate → Flows** |
| User scripting | **Settings → Automate → Scripts** in a QuickJS sandbox |
| Extension marketplace | Organization-installed **Apps** and the **App Library** |
| Document repository | **Home → File Cabinet** |
| System history | **Settings → Administration → Audit Log** |

## Record workflow

Selecting a row opens one primary record in a drawer over the list. **New**
creates a real autosaving draft. Posting and approval remain explicit, and
secondary verbs live in the record's **Actions** menu. Expand the drawer to
fullscreen when the record needs more space.

## Dimensions and custom data

Map legal entities to subsidiaries and reporting attributes to purpose-built
dimensions. Do not flatten every source segment into the chart of accounts.
Native capabilities use typed configuration; organization-defined extra fields
belong in the customization layer.

## Reporting and scripting

Use **Saved Views** for reusable record selections, financial reports for the
books, and analytics for operating signals. Authorized SQL users query the real
PostgreSQL model through a SELECT-only role. Scripts execute real JavaScript in
a governed QuickJS sandbox.

## Migration advice

Inventory custom records, fields, forms, workflows, scripts, queries, roles,
segments, subsidiaries, accounting books, tax, revenue arrangements, and
integrations before mapping transactions. Decide which customizations represent
a real business requirement and which only compensate for the old interface.

Prove trial balance and account-period activity, then reconcile AR, AP, bank,
tax, fixed assets, inventory, projects, revenue, and intercompany detail. Keep
the source read-only after cutover for historical evidence.
`,
}

export const switchingArticles: DocArticle[] = [
  switchingFromSmallBusinessSystems,
  switchingFromEnterpriseSystems,
]
