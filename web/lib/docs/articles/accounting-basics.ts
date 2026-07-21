import type { DocArticle } from '../types'

export const accountingModel: DocArticle = {
  slug: 'accounting-model',
  title: 'How Accounting Works in OpenBooks',
  category: 'accounting',
  order: 1,
  summary:
    'Understand business transactions, ledger entries, books, periods, subledgers, and immutable accounting evidence.',
  updated: '2026-07-19',
  keywords: ['double entry', 'ledger', 'journal entry', 'subledger', 'book', 'period', 'posting', 'immutability'],
  related: ['transaction-lifecycle', 'chart-of-accounts-and-dimensions', 'period-close'],
  body: `# How Accounting Works in OpenBooks

OpenBooks keeps the business record separate from its general-ledger projection.
An invoice describes a sale; its journal entry records the accounting effect.
Posting connects the two.

## Transactions and ledger entries

A draft transaction has no ledger impact. When it is posted, the accounting
engine validates the record and creates exactly one balanced journal entry.
Every entry has lines whose debits and credits sum to zero. The database enforces
that balance rather than relying only on the user interface.

Open a posted transaction and inspect its accounting impact when you need to
explain a balance. Do not recreate subledger activity with manual journals merely
to make a total agree; preserve the operational detail that supports the control
account.

## Subledgers and control accounts

Customer invoices, credits, receipts, and applications support accounts
receivable. Vendor bills, credits, payments, and applications support accounts
payable. Assets, inventory, tax, projects, and revenue recognition add their own
supporting detail.

Reconcile each subledger total to its general-ledger control account. A trial
balance can be correct while an open-item subledger is wrong, so both levels
matter.

## Books, subsidiaries, and dimensions

An accounting book represents an accounting basis. Subsidiaries represent legal
entities within the organization. Dimensions such as department, location,
class, and project explain where activity belongs without multiplying the chart
of accounts.

The same economic event may need subsidiary and dimension context on each line.
Configure those structures before loading history so reporting remains
consistent from the opening period onward.

## Open and closed periods

Open periods allow authorized posting. A posted transaction may be amended in
place only through the audited engine path and only while every affected old and
new accounting scope remains open. The system records an immutable before/after
business and ledger snapshot with the reason.

Closed-period impact is immutable. Corrections require controlled reopening or a
new reversal and correcting transaction. This preserves what was known and
reported at the time of close.

## Exact money

Ledger amounts use fixed-precision decimal money with four fractional places.
Posting, application, foreign exchange, tax, and other financial engines avoid
binary floating-point math. When an imported source is out of balance, the
correct response is to diagnose the source or mapping—not force a rounding line
without an accounting policy.
`,
}

export const transactionLifecycle: DocArticle = {
  slug: 'transaction-lifecycle',
  title: 'Transaction Lifecycle: Draft to Posted',
  category: 'accounting',
  order: 2,
  summary: 'Follow a transaction through draft, approval, posting, amendment, reversal, and deletion controls.',
  updated: '2026-07-19',
  keywords: ['draft', 'submit', 'approve', 'post', 'amend', 'delete', 'reverse', 'void', 'status'],
  related: ['navigation-and-records', 'accounting-model', 'audit-log'],
  body: `# Transaction Lifecycle: Draft to Posted

## Draft

Choosing **New** creates a persisted draft. Drafts autosave and have no ledger
impact. Add the party, date, currency, lines, dimensions, tax treatment, terms,
and attachments required by your organization's policy.

Delete an unwanted draft from its **Actions** menu. A draft can be safely
removed because it has not changed the ledger.

## Submit and approve

When an approval flow applies, **Submit** evaluates the configured rules and
sends the transaction to the appropriate approvers. Approval authority is
separate from edit and posting authority. A rejected transaction returns to a
state where the issue can be corrected and resubmitted.

Reviewers should inspect source evidence, coding, tax, dates, dimensions, and
duplicate risk—not only the total.

## Post

Posting validates the transaction, verifies the accounting period and accounts,
and creates one balanced journal entry. After posting, the transaction is part of
the books and appears in financial and subledger reports.

If posting is unavailable, check required fields, approval state, account status,
period locks, currency rates, and your permissions.

## Amend an open-period transaction

Authorized users can edit certain posted transactions while all affected scopes
remain open. OpenBooks re-materializes the same ledger entry atomically and writes
a complete before/after audit record. The history is not erased.

An amendment that moves a date, book, subsidiary, account, or other accounting
scope must pass the open-period test for both the original and resulting scope.

## Correct closed-period activity

Closed-period impact cannot be rewritten. Use one of two governed paths:

1. reopen the affected scope under your close policy, amend, revalidate, and
   close again; or
2. post a reversal and a correcting transaction in an open period.

The second approach is usually clearer after financial statements were issued.

## Delete or reverse

Deleting a posted transaction is limited to authorized open-period scenarios and
is fully audited. A reversal is a new transaction linked to the source and is
the normal correction when the original must remain visible. Never use an
unrelated manual journal to conceal the source error.
`,
}

export const chartOfAccountsAndDimensions: DocArticle = {
  slug: 'chart-of-accounts-and-dimensions',
  title: 'Chart of Accounts and Dimensions',
  category: 'accounting',
  order: 3,
  summary: 'Design accounts and reporting dimensions that stay usable as the organization grows.',
  updated: '2026-07-19',
  keywords: ['chart of accounts', 'account', 'department', 'location', 'class', 'dimension', 'subsidiary', 'segment'],
  related: ['accounting-model', 'quick-start', 'financial-reports'],
  body: `# Chart of Accounts and Dimensions

## Use accounts for economic nature

The chart of accounts should explain what an amount is: cash, receivable,
revenue, payroll, rent, inventory, tax, and so on. Use dimensions to explain who,
where, or why. Creating a separate expense account for every department or
location produces a chart that is difficult to govern and report.

Each account has a number, name, type, status, and posting behavior. Summary or
inactive accounts cannot receive new postings. Control accounts should be driven
by their subledgers.

## Use dimensions for analysis

Common dimensions include:

- **Subsidiary** for the legal entity;
- **Department** for organizational responsibility;
- **Location** for a physical or operating site;
- **Class** for a line of business or management classification; and
- **Project** for job-level revenue, cost, billing, and profitability.

Choose a single meaning for each dimension and document it. If department means
cost center on one transaction and service line on another, reports will not be
comparable.

## Configure before importing

Map source accounts by stable external identifier when possible. Separately map
source segments or tracking categories to dimensions. Confirm which values are
active, which may be posted at header or line level, and which are mandatory for
specific account types.

Avoid embedding source-system names in the permanent chart unless they are part
of the organization's own accounting policy.

## Review changes safely

Before adding an account, search for an existing account with the same economic
purpose. Archive unused accounts only after confirming they are not needed by
open transactions, control-account configuration, reports, rules, or imports.

Test account and dimension changes with a small posted transaction and review the
trial balance, general ledger, and relevant management report.
`,
}

export const partiesItemsAndProjects: DocArticle = {
  slug: 'parties-items-and-projects',
  title: 'Customers, Vendors, Items, and Projects',
  category: 'accounting',
  order: 4,
  summary: 'Understand the shared master records used by sales, purchases, projects, inventory, and reporting.',
  updated: '2026-07-20',
  keywords: ['customer', 'vendor', 'employee', 'party', 'item', 'service', 'project', 'master data'],
  related: ['sales-workflow', 'purchasing-workflow', 'project-types'],
  body: `# Customers, Vendors, Items, and Projects

## Parties and roles

Customers, vendors, and employees are role-specific views of shared party
identity. A company that both buys from and sells to your organization can hold
both customer and vendor roles without duplicating its legal identity.

Role views keep operational fields focused while preserving one source of truth
for names, addresses, contacts, tax details, and external references.
Address and bank-detail countries are selected from the shared ISO country list
so the same country code is stored consistently across records.

## Items and services

Items describe what is bought, sold, stocked, or billed. Their configuration can
drive income, expense, asset, cost-of-goods-sold, tax, inventory, and revenue
recognition behavior. Choose the correct item kind and accounts before using it
on live transactions.

Archive an obsolete item rather than reusing its code for a different economic
purpose. Historical transactions must retain their original meaning.

## Projects

Projects connect customers, time, costs, billing, revenue, budgets, and
profitability. A project type supplies configurable costing, invoicing,
recognition, and backup defaults. Customer and project preferences can override
the allowed subset.

Use dimensions for broad reporting and projects for job-level operational
control. A project can itself carry department, location, class, or subsidiary
context.

The project flyout organizes the record by purpose:

- **Overview** holds the project's identity, type, dates, ownership, customer,
  contract, and invoicing preferences. Its fields use the same customizable
  form layout engine as transaction headers, including visibility, ordering,
  grouping, labels, and column spans.
- **Work breakdown** is the single place to plan tasks, estimated hours, and
  estimated costs. Those task costs roll up into the project's cost budget.
- **Financials & budget** compares that budget with actual and committed cost
  alongside project profitability and revenue recognition.
- **Cost & time**, **Charges**, and **Billing** cover operational activity.
- **Transactions** lists only the accounting and order records tagged to the
  project.

## Master-data hygiene

Before importing transactions:

1. normalize names and codes;
2. merge known duplicates;
3. preserve stable source IDs;
4. validate default currencies, terms, taxes, and accounts; and
5. archive records that should not be selected for new work.

Good master data prevents duplicate parties, unmapped items, inconsistent aging,
and misleading project reports later.
`,
}
