import type { DocArticle } from '../types'

export const quickStart: DocArticle = {
  slug: 'quick-start',
  title: 'Quick Start for New Organizations',
  category: 'getting-started',
  order: 2,
  summary:
    'A practical sequence for configuring an organization, entering opening data, and preparing the first live workflow.',
  updated: '2026-07-19',
  keywords: ['checklist', 'implementation', 'onboarding', 'first week', 'go live', 'setup'],
  related: ['welcome', 'accounting-model', 'migration-and-cutover'],
  body: `# Quick Start for New Organizations

Use this sequence whether you are starting fresh or moving from another system.
The objective is not merely to make the first transaction; it is to establish
controls that will still be correct at month end.

## 1. Establish the organization

In **Settings → Company Setup**, confirm the legal name, functional
currency, fiscal calendar, time zone, and default language. If the organization
has multiple legal entities, create the subsidiary hierarchy before importing
accounts or transactions.

Create accounting books only when you need parallel statutory or management
bases. Most organizations should begin with one primary book.

## 2. Build the accounting foundation

1. Review or import the **Chart of Accounts**.
2. Create accounting periods for the first operating year.
3. Configure departments, locations, classes, projects, and any other dimensions
   used in reporting or approvals.
4. Configure tax codes and rates, payment terms, number sequences, currencies,
   and exchange-rate sources that apply to your business.
5. Assign posting and control accounts for receivables, payables, tax, inventory,
   retained earnings, payments, and other enabled modules.

Do not start with transactions and plan to repair the structure later. Accounts,
periods, dimensions, and control accounts determine where transactions post.

## 3. Set up people and controls

Invite users, assign the narrowest suitable roles, and confirm who can create,
approve, post, pay, close, reopen, import, and administer. Configure approval
rules before the first transaction that should require approval.

Use a non-administrator test user to confirm that daily work is visible and
administrative work is not.

## 4. Add operating records

Load customers, vendors, employees, items and services, bank accounts, projects,
and opening fixed assets. Archive duplicates before importing transactions.
Stable external IDs are valuable during migration because they make repeated
imports and reconciliation easier to explain.

## 5. Prove one complete workflow

In a test period, run one small example through each workflow you will use:

- customer invoice → posting → receipt → application;
- vendor bill → approval → payment → application;
- bank statement import → match → reconciliation;
- journal → approval or posting → financial report; and
- project time or cost → billing, if projects are enabled.

Inspect the resulting journal entry and reports. A successful form submission is
not enough; the ledger projection must be correct.

## 6. Load opening balances or history

Choose an explicit migration strategy: full history, comparative history plus
open items, or opening balances plus open items. Reconcile the trial balance by
account, open receivables and payables by party and transaction, bank balances,
tax balances, retained earnings, and key subledgers before cutover.

## 7. Prepare go-live

Document the final source-system cutoff time, disable or control source posting,
run the final delta import, repeat reconciliation, and obtain named approval for
cutover. Keep the source system read-only for evidence after go-live.

See [Migration and cutover](/docs/migration-and-cutover) for the full control
plan and [Reconciliation before cutover](/docs/reconciliation-before-cutover)
for the minimum proof package.
`,
}

export const navigationAndRecords: DocArticle = {
  slug: 'navigation-and-records',
  title: 'Navigation, Lists, and Record Drawers',
  category: 'getting-started',
  order: 3,
  summary: 'Learn the shared interaction patterns used throughout the application.',
  updated: '2026-07-19',
  keywords: ['navigation', 'top navigation', 'sidebar', 'search', 'filter', 'pagination', 'drawer', 'draft', 'autosave', 'actions'],
  related: ['quick-start', 'transaction-lifecycle'],
  body: `# Navigation, Lists, and Record Drawers

OpenBooks uses the same interaction model across accounting, sales, purchases,
projects, and administration. Learning these patterns once makes the rest of
the system predictable.

## Navigation

The main navigation is grouped by complete business journey: **My Work**,
**Customers**, **Purchasing**, **Operations**, **Banking**, **Accounting**,
**Insights**, and **Settings**. Your organization can reorder or hide modules,
and your permissions determine which destinations you can see.

Larger workspace menus use labeled sections. For example, **Customers** keeps
relationship records, pipeline work, and the sell-to-collect flow together;
**Accounting** separates ledger, revenue, assets, planning, compliance, and
close work without scattering them across unrelated menus.

The top menu is the default layout. Each workspace opens as a menu, keeping the
full page width available for lists, reports, and record drawers. If you prefer
a persistent left rail, choose **Menu layout → Sidebar** from your account menu;
your personal choice overrides the organization default.

**Documentation** and **Apps** are persistent utilities in the header rather
than workspaces. Use the book icon for help and the grid icon to launch installed
apps. The global create button and global search remain available beside them.

If a guide names a page that is missing from your navigation, first check your
role with an administrator. A hidden module does not imply that its records were
deleted.

## Lists

Record lists share four controls:

- **Search** matches the important identifiers and names for that record type.
- **Filters** narrow status, date, owner, account, or other relevant fields.
- **Column headings** with sort controls change the active ordering.
- **Pagination** keeps large result sets bounded.

Search, filters, sorting, and page position are stored in the URL. You can
bookmark or share a filtered list without exporting it.

## Record drawers

Selecting a record normally opens it in a drawer over the list. The list stays
in place, including its filters and scroll context. The drawer has one primary
record and three consistent header controls:

- **Edit** switches the record into its editable state when allowed.
- **Actions** contains posting, approval, conversion, payment, and other verbs.
- **Fullscreen** expands the same drawer when more working space is useful.

Closing the drawer returns to the preserved list. Internal links use the client
router, so moving between records does not reload the entire application shell.

## New records and drafts

Choosing **New** immediately creates a real draft on the server and opens it in
the drawer. Draft fields autosave after a short delay. Posting, submitting, or
approving remains an explicit action; autosave never posts a transaction.

Because a draft is real, leaving the drawer does not discard it. Find it again
with the **Draft** status filter. Delete unwanted drafts rather than assuming
they vanished.

## Status and actions

Status badges describe the current lifecycle state. Available actions depend on
that state and your permissions. When an action is absent, check the status,
required fields, approval state, accounting period, and your role before treating
it as an error.
`,
}

export const glossary: DocArticle = {
  slug: 'glossary',
  title: 'OpenBooks Glossary',
  category: 'getting-started',
  order: 4,
  summary: 'Plain-language definitions for the accounting and product terms used throughout the documentation.',
  updated: '2026-07-19',
  keywords: ['definitions', 'terminology', 'document', 'transaction', 'posting', 'ledger', 'dimension', 'party'],
  related: ['accounting-model', 'transaction-lifecycle'],
  body: `# OpenBooks Glossary

## Accounting terms

**Accounting book** — a complete accounting basis with its own posting and close
state. The primary book is the ordinary source of financial statements.

**Accounting period** — a dated reporting interval, usually a month. Period
locks determine whether modules can post or amend activity in that interval.

**Control account** — a general-ledger account maintained by a subledger, such
as accounts receivable or accounts payable. Ordinary transactions should reach
it through the relevant business workflow.

**Dimension** — an analysis attribute attached to a transaction or line, such as
department, location, class, project, or subsidiary.

**Journal entry** — the balanced debit-and-credit projection in the general
ledger. A posted business transaction produces exactly one journal entry.

**Posting** — the controlled act that projects a business transaction into the
ledger. Saving a draft is not posting.

**Reversal** — a new entry that offsets a posted entry while preserving the
original evidence.

**Subledger** — detailed operational records supporting a control-account
balance, such as customer invoices and receipts supporting accounts receivable.

## Record terms

**Party** — the shared identity behind a customer, vendor, employee, or other
business relationship. One real organization can have more than one role.

**Transaction** — the user-facing business record: invoice, bill, payment,
journal, order, expense, and similar records. Internal database names may use
the word document, but the application calls these records transactions.

**Draft** — a persisted but unposted record. Drafts can be edited or deleted
without changing the ledger.

**Posted** — a transaction with a ledger entry. Changes are controlled and
audited, and closed-period impact is immutable.

**Application** — the link that applies a payment or credit to one or more open
invoices or bills.

**Record drawer** — the panel that opens over a list for viewing and editing one
primary record without losing list context.

## Platform terms

**App** — an organization-installed extension with governed files, permissions,
and backend actions.

**Flow** — a configured automation or approval workflow triggered by record or
business events.

**Saved View** — a reusable, shareable view of selected record data and filters.

**Source connection** — a per-organization integration used to import or mirror
data from another system. Connection secrets are sealed and tenant-scoped.
`,
}
