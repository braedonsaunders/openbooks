import type { DocArticle } from '../types'

export const comingFromNetSuite: DocArticle = {
  slug: 'coming-from-netsuite',
  title: 'Coming from NetSuite',
  category: 'switching',
  order: 1,
  summary:
    'Map familiar NetSuite navigation, records, segments, searches, workflows, scripts, and controls to OpenBooks.',
  updated: '2026-07-19',
  keywords: [
    'NetSuite',
    'SuiteAnalytics',
    'SuiteFlow',
    'SuiteScript',
    'SuiteApp',
    'saved search',
    'OneWorld',
    'familiarization',
  ],
  related: ['navigation-and-records', 'migration-and-cutover', 'analytics-and-saved-views'],
  body: `# Coming from NetSuite

OpenBooks covers many of the same accounting and operations jobs, but it does not
reproduce NetSuite screens field for field. Start with the business purpose of a
record, then learn the shared list-and-drawer workflow.

## Familiar concepts

| NetSuite concept | OpenBooks destination |
| --- | --- |
| Centers, roles, and permissions | Configurable navigation plus **Users, Roles, and Permissions** |
| OneWorld subsidiaries | **Company Settings → Subsidiaries** |
| Chart of Accounts | **Accounting → Chart of Accounts** |
| Department, Class, Location | Organization dimensions in **Company Settings** |
| Customers, vendors, employees | Role-specific views of shared parties |
| Items | **Sales → Items & Services** and **Purchases → Inventory** |
| Transactions | Sales, Purchases, Banking, and Accounting lists with record drawers |
| Posting periods | **Accounting → Period Close** and accounting-period configuration |
| Saved Searches | **Reporting → Saved Views** |
| SuiteAnalytics | **Analytics**, **Dashboard Builder**, custom reports, and governed query |
| SuiteFlow | **Administration → Build → Flows** |
| SuiteScript | **Administration → Build → Scripts** in a QuickJS sandbox |
| SuiteApps | Organization-installed **Apps** and the **App Library** |
| File Cabinet | **Home → File Cabinet** |
| System Notes | **Administration → Audit Log** |

## The biggest workflow change

Record creation and editing is flyout-first. Selecting a row opens one primary
record in a drawer over the list. **New** creates a real autosaving draft.
Posting and approval remain explicit, and secondary verbs live in the record's
**Actions** menu.

You do not need to navigate through a separate full page for every view or edit.
Expand the drawer to fullscreen when the record needs more space.

## Segments and custom data

Map legal entity to subsidiary and reporting attributes to purpose-built
dimensions. Do not flatten every custom segment into the chart of accounts.
Native capabilities use typed configuration; organization-defined extra fields
belong in the customization layer.

## Searches, reporting, and scripting

Use **Saved Views** for reusable record selections, financial reports for the
books, and analytics for operating signals. Authorized SQL users query the real
PostgreSQL model through a SELECT-only role rather than a proprietary formula
dialect. Scripts execute real JavaScript in a governed QuickJS sandbox.

## Migration advice

Inventory custom records, fields, forms, workflows, scripts, searches, roles,
segments, subsidiaries, accounting books, tax, revenue arrangements, and
integrations before mapping transactions. Decide which customizations represent
a real business requirement and which only compensate for the old interface.

Prove trial balance and account-period activity, then reconcile AR, AP, bank,
tax, fixed assets, inventory, projects, revenue, and intercompany detail. Keep
the source read-only after cutover for historical evidence.
`,
}

export const comingFromQuickBooksOnline: DocArticle = {
  slug: 'coming-from-quickbooks-online',
  title: 'Coming from QuickBooks Online',
  category: 'switching',
  order: 2,
  summary:
    'Translate QuickBooks Online lists, forms, classes, bank workflows, reports, and close controls into OpenBooks.',
  updated: '2026-07-19',
  keywords: [
    'QuickBooks Online',
    'QBO',
    'classes',
    'locations',
    'bank feed',
    'products and services',
    'familiarization',
  ],
  related: ['quick-start', 'banking-and-reconciliation', 'migration-and-cutover'],
  body: `# Coming from QuickBooks Online

OpenBooks separates business transactions from their ledger entries and offers
deeper configuration, approval, close, and audit controls. The daily sales,
purchasing, and bank concepts remain familiar.

## Familiar concepts

| QuickBooks Online concept | OpenBooks destination |
| --- | --- |
| Customers and vendors | **Sales → Customers** and **Purchases → Vendors** |
| Products and services | **Sales → Items & Services** |
| Invoices and sales receipts | **Sales → Invoices** and **Customer Payments** |
| Bills and bill payments | **Purchases → Bills** and **Vendor Payments** |
| Expenses | **Purchases → Expenses** |
| Chart of accounts | **Accounting → Chart of Accounts** |
| Classes and locations | Configurable dimensions in **Company Settings** |
| Bank transactions and rules | **Banking → Match & Categorize** and **Reconciliation Rules** |
| Reconcile | **Banking → Reconciliations** |
| Closing date | Accounting-period locks and the governed **Period Close** workflow |
| Custom reports | Financial Reports, Saved Views, Analytics, and Dashboard Builder |

## Transactions and posting

Creating a new record makes a persisted draft. Saving or autosaving does not
change the ledger. Approval and posting are explicit actions, and each posted
business transaction produces one balanced journal entry you can inspect.

Use customer receipts, vendor payments, credits, and applications to maintain
open-item detail. Avoid direct journals to receivables or payables control
accounts.

## Classes, locations, and projects

Map QBO classes and locations according to their real reporting purpose. A class
used as department should become department; a location should remain location.
Use projects for job-level time, cost, billing, and profitability rather than as
a generic tag.

## Bank workflow

Statement lines are external evidence. Match them to existing receipts,
payments, transfers, or journals; categorize only genuine missing activity.
Complete and sign off a reconciliation separately from transaction matching.

## Migration advice

Export the detailed general ledger, trial balance, chart, lists, open invoices
and bills, unapplied cash and credits, reconciliations, tax detail, attachments,
and audit evidence needed by policy. Preserve stable QBO identifiers where
available.

QBO report totals alone are not enough. Reconcile account-period activity and
open items, and verify class, location, customer, vendor, project, tax, and
currency detail on representative transactions.
`,
}

export const comingFromQuickBooksDesktop: DocArticle = {
  slug: 'coming-from-quickbooks-desktop',
  title: 'Coming from QuickBooks Desktop',
  category: 'switching',
  order: 3,
  summary:
    'Learn the OpenBooks equivalents for QuickBooks Desktop lists, forms, classes, reports, and the read-only connector.',
  updated: '2026-07-19',
  keywords: [
    'QuickBooks Desktop',
    'QBD',
    'lists',
    'forms',
    'classes',
    'memorized reports',
    'Web Connector',
    'familiarization',
  ],
  related: ['quickbooks-desktop-connector', 'coming-from-quickbooks-online', 'migration-and-cutover'],
  body: `# Coming from QuickBooks Desktop

The core list and form concepts are familiar, while OpenBooks adds server-side
drafts, granular permissions, governed close, tenant-configured integrations, and
a browser-based record workflow.

## Familiar concepts

| QuickBooks Desktop concept | OpenBooks destination |
| --- | --- |
| Customer, Vendor, Employee lists | Role-specific party lists |
| Item List | **Items & Services** and **Inventory** |
| Chart of Accounts | **Accounting → Chart of Accounts** |
| Classes | Configurable dimensions; map by actual business purpose |
| Invoices and Receive Payments | **Invoices** and **Customer Payments** |
| Enter Bills and Pay Bills | **Bills** and **Vendor Payments** |
| Make General Journal Entries | **Accounting → Journals** |
| Bank Feeds and Reconcile | **Banking → Match & Categorize** and **Reconciliations** |
| Memorized or customized reports | Saved report parameters, custom reports, and Saved Views |
| Closing Date | Accounting periods, locks, and **Period Close** |

## Record workflow

Lists use URL-based search, filters, sorting, and pagination. Records open in a
drawer. **New** immediately creates a server-side draft that autosaves; use the
**Actions** menu to submit, post, convert, pay, or reverse according to status
and permission.

## Read-only migration connector

OpenBooks includes a QuickBooks Web Connector bridge for read-only historical
capture. The Windows machine initiates HTTPS connections, and the connector does
not write to the company file. It prioritizes exact GL migration and
reconciliation; it does not recreate every QuickBooks form layout or application
relationship as a native record.

See [QuickBooks Desktop Connector](/docs/quickbooks-desktop-connector) for setup,
regional requirements, security, retention, and diagnostics.

## Migration advice

Repair and verify the company file before capture, close unintended open windows,
and retain a final backup. Reconcile the accrual-basis trial balance and
debit-positive account activity for each posting month. Separately reconcile
open receivables, payables, inventory, payroll, tax, and bank details needed at
cutover.
`,
}

export const comingFromOdoo: DocArticle = {
  slug: 'coming-from-odoo',
  title: 'Coming from Odoo',
  category: 'switching',
  order: 4,
  summary:
    'Map Odoo apps, companies, contacts, products, journals, analytic accounting, documents, and automation to OpenBooks.',
  updated: '2026-07-19',
  keywords: [
    'Odoo',
    'analytic account',
    'analytic plan',
    'contacts',
    'products',
    'journals',
    'apps',
    'familiarization',
  ],
  related: ['parties-items-and-projects', 'apps', 'migration-and-cutover'],
  body: `# Coming from Odoo

Both systems connect accounting with operational modules, but their record and
extension models differ. Map by business purpose rather than assuming an Odoo
model has a one-to-one destination.

## Familiar concepts

| Odoo concept | OpenBooks destination |
| --- | --- |
| Companies | Subsidiaries within the organization, when they are legal entities |
| Contacts with customer/vendor use | Shared parties with customer and vendor roles |
| Products and product categories | Items & Services, inventory profiles, and item categories |
| Customer invoices | **Sales → Invoices** |
| Vendor bills | **Purchases → Bills** |
| Payments and reconciliation | Customer/Vendor Payments plus **Banking** |
| Accounts and journal items | Chart of Accounts and posted journal-entry lines |
| Analytic accounts and plans | Projects and configurable dimensions, depending on purpose |
| Documents | **File Cabinet** and record evidence |
| Automated actions and approvals | **Flows** and approval configuration |
| Installed modules | Native modules plus governed organization **Apps** |

## Journals mean something different

Odoo uses journals as operational groupings for transactions. In OpenBooks, a
journal entry is the balanced ledger projection or a manual accounting
transaction. Map Odoo bank, sales, purchase, and miscellaneous journal context to
books, accounts, transaction kinds, number sequences, and payment configuration
as appropriate; do not create one OpenBooks account per Odoo journal.

## Analytic accounting

Classify each analytic plan and account by purpose. Use projects for job-level
time, billing, cost, and profitability. Use department, location, class, or
another configured dimension for stable management reporting. Preserve analytic
distribution at the line level when it affects reporting.

## Migration advice

Export posted and draft moves separately, including move lines, reconciliations,
currencies, taxes, fiscal positions, products, contacts, analytic distributions,
assets, inventory valuation, attachments, and multi-company context. Decide how
Odoo custom modules and fields map to native OpenBooks capabilities, custom
fields, custom records, flows, scripts, or apps.

Reconcile by company, account, period, currency, tax, partner, and analytic
dimension. Confirm payment and partial-reconciliation chains so open items do not
reappear after cutover.
`,
}

export const comingFromXero: DocArticle = {
  slug: 'coming-from-xero',
  title: 'Coming from Xero',
  category: 'switching',
  order: 5,
  summary:
    'Translate Xero contacts, items, tracking, bank reconciliation, invoices, bills, assets, and reports into OpenBooks.',
  updated: '2026-07-19',
  keywords: [
    'Xero',
    'tracking categories',
    'contacts',
    'bank reconciliation',
    'manual journal',
    'fixed assets',
    'familiarization',
  ],
  related: ['banking-and-reconciliation', 'chart-of-accounts-and-dimensions', 'migration-and-cutover'],
  body: `# Coming from Xero

The daily invoice, bill, payment, and reconciliation concepts are familiar.
OpenBooks adds explicit posting lifecycles, configurable books and periods,
granular administration, and deeper workflow controls.

## Familiar concepts

| Xero concept | OpenBooks destination |
| --- | --- |
| Contacts | Shared parties with customer and vendor roles |
| Products and services | **Items & Services** |
| Sales invoices and credit notes | **Sales → Invoices** and customer credits |
| Bills and credit notes | **Purchases → Bills** and vendor credits |
| Bank statements and reconciliation | **Banking → Match & Categorize** and **Reconciliations** |
| Tracking categories | Configurable dimensions such as department, location, or class |
| Manual journals | **Accounting → Journals** |
| Fixed assets | **Accounting → Fixed Assets** and tax depreciation |
| Reports | Financial Reports, Analytics, Dashboard Builder, and Saved Views |
| Lock dates | Accounting periods, module locks, and governed Period Close |

## Tracking and parties

Map each tracking category according to what it measures. Preserve contact roles
without duplicating a business that is both customer and supplier. Validate
default currencies, tax treatment, terms, and control-account behavior.

## Bank reconciliation

Import statement evidence, match it to existing accounting transactions, and
categorize genuine missing activity. A signed-off reconciliation separately
proves the statement ending balance to the ledger.

## Migration advice

Extract journals and source transactions, contacts, items, currencies, taxes,
tracking, bank statements, reconciliations, assets, attachments, and report
settings required by policy. Reconcile trial balance and account-period activity,
then open invoices, bills, credits, cash, tax, assets, and tracking detail.

Test partial payments, overpayments, prepayments, credit applications, foreign
currency, and bank transfers explicitly; these are common places for a ledger
total to agree while open-item detail does not.
`,
}

export const comingFromSageIntacct: DocArticle = {
  slug: 'coming-from-sage-intacct',
  title: 'Coming from Sage Intacct',
  category: 'switching',
  order: 6,
  summary:
    'Map Sage Intacct entities, dimensions, modules, approvals, reports, and platform customizations to OpenBooks.',
  updated: '2026-07-19',
  keywords: [
    'Sage Intacct',
    'entities',
    'dimensions',
    'statistical account',
    'custom report',
    'approval',
    'familiarization',
  ],
  related: ['coming-from-netsuite', 'company-settings', 'migration-and-cutover'],
  body: `# Coming from Sage Intacct

OpenBooks shares an emphasis on dimensional accounting, subledgers, controls,
and multi-entity operations. The main adjustment is the shared drawer workflow
and the way configuration, reports, automation, and extensions are organized.

## Familiar concepts

| Sage Intacct concept | OpenBooks destination |
| --- | --- |
| Entities and entity hierarchy | Subsidiaries and consolidation configuration |
| General Ledger | Chart of Accounts, Journals, books, periods, and Financial Reports |
| Dimensions | Departments, locations, classes, projects, parties, and other configured dimensions |
| Accounts Payable and Receivable | Purchases and Sales workflows |
| Cash Management | Banking, matching, rules, and reconciliations |
| Purchasing and Order Entry | Purchase Orders, Sales Orders, bills, and invoices |
| Time and project accounting | Projects, Weekly Timesheets, project types, and profitability |
| Dashboards and reports | Analytics, Dashboard Builder, custom reports, and Saved Views |
| Platform Services customization | Custom fields, forms, custom records, flows, scripts, APIs, and apps |

## Dimensions and entities

Map the entity hierarchy to legal subsidiaries. Map each dimension by its
accounting or operational meaning, preserving line-level values. Avoid turning
dimension combinations into separate accounts.

Review intercompany due-to/due-from mappings, elimination entities, base
currencies, rate types, and consolidation policy before loading cross-entity
history.

## Controls and workflow

Configure roles, approvals, accounting books, periods, close blueprints, payment
operations, tax, and number sequences before trial transactions. Test with the
actual preparer, approver, payer, and closer roles rather than only an
administrator.

## Migration advice

Inventory custom dimensions, objects, reports, dashboards, approval policies,
allocations, statistical data, attachments, integrations, and multi-entity
configuration. Map customizations to native capabilities first and use the
customization or app layers only for genuine organization-specific needs.

Reconcile by entity, book, account, period, currency, and dimension, plus every
material subledger. Test consolidation and eliminations independently from
single-entity trial balances.
`,
}

export const switchingArticles: DocArticle[] = [
  comingFromNetSuite,
  comingFromQuickBooksOnline,
  comingFromQuickBooksDesktop,
  comingFromOdoo,
  comingFromXero,
  comingFromSageIntacct,
]
