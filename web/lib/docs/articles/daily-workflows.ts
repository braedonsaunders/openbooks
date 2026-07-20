import type { DocArticle } from '../types'

export const salesWorkflow: DocArticle = {
  slug: 'sales-workflow',
  title: 'Sales: Estimate to Cash',
  category: 'transactions',
  order: 1,
  summary: 'A practical tour of estimates, sales orders, invoices, credits, receipts, and customer balances.',
  updated: '2026-07-19',
  keywords: ['sales', 'estimate', 'quote', 'sales order', 'invoice', 'credit memo', 'receipt', 'accounts receivable'],
  related: ['payments-and-applications', 'transaction-lifecycle', 'financial-reports'],
  body: `# Sales: Estimate to Cash

The sales workflow can begin with an estimate, a sales order, or directly with a
customer invoice. Use only the stages your business needs; do not create a
document merely to imitate a source-system screen.

## Prepare the records

Before the first sale, confirm the customer, currency, terms, tax treatment,
receivables control account, number sequence, items or services, income accounts,
and required dimensions. Project-based sales should also have a project and
project type.

## Estimate and sales order

An **Estimate** records a proposed sale and has no ledger impact. Convert an
accepted estimate to a **Sales Order** when fulfillment, commitment, or progress
must be tracked before invoicing. Conversion preserves the relationship between
the records so users can follow the chain.

A sales order is also non-posting. Use its **Actions** menu for conversions and
other workflow verbs.

## Invoice

An invoice records the customer's obligation. Create it directly or convert an
eligible upstream record. Review quantities, rates, taxes, dimensions, due date,
and attachments, then follow your approval and posting policy.

Posting normally debits accounts receivable and credits revenue, tax, or other
configured accounts. Inspect the generated ledger entry when validating a new
item, tax code, or workflow.

## Credit and correction

Use a customer credit for a genuine reduction of an open or prior sale. Apply it
to the appropriate invoice rather than posting an unrelated journal against the
receivables control account. Correct data-entry errors according to the
transaction lifecycle and period state.

## Receipt and application

Record the customer receipt to the correct bank or clearing account, then apply
it to one or more open invoices and credits. The unapplied remainder remains
visible until assigned or refunded.

Review receivables aging, customer statements, the AR register, and the
receivables control-account reconciliation as part of the close.
`,
}

export const purchasingWorkflow: DocArticle = {
  slug: 'purchasing-workflow',
  title: 'Purchases: Order to Payment',
  category: 'transactions',
  order: 2,
  summary: 'A practical tour of purchase orders, bills, credits, approvals, payments, and vendor balances.',
  updated: '2026-07-19',
  keywords: ['purchase', 'purchase order', 'vendor bill', 'vendor credit', 'accounts payable', 'payment', 'approval'],
  related: ['payments-and-applications', 'transaction-lifecycle', 'file-cabinet'],
  body: `# Purchases: Order to Payment

The purchase workflow can begin with a purchase order or directly with a vendor
bill. Your approval and evidence policy should determine the path.

## Prepare the records

Confirm the vendor, currency, terms, tax treatment, payables control account,
items or expense accounts, required dimensions, payment method, and approval
rules. Attach source evidence to the transaction or store it in the governed File
Cabinet location required by policy.

## Purchase order

A **Purchase Order** records an authorized commitment and has no ledger impact.
Use it when the organization needs pre-approval, committed-cost reporting, or a
formal source for the later bill. Convert it through the record's **Actions**
menu rather than entering the same purchase again.

## Vendor bill

A bill records the obligation to the vendor. It may be entered manually, created
from capture, or converted from a purchase order. Validate the vendor invoice
number, dates, quantities, accounts, dimensions, tax, and duplicate risk before
approval and posting.

Posting normally debits expense, asset, inventory, tax, or other configured
accounts and credits accounts payable.

## Vendor credit

Use a vendor credit for returned goods, price adjustments, and other genuine
reductions. Apply it to the relevant bill or leave it open for a future
application. Do not bury vendor credits in manual control-account journals.

## Payment

Select approved, due open items for payment according to cash and authorization
policy. Review the funding account, payment date, method, remittance detail, and
applications before completing the run or payment.

At close, reconcile vendor aging and unapplied credits to the AP control account,
review old drafts and approvals, and investigate duplicate or unmatched source
evidence.
`,
}

export const paymentsAndApplications: DocArticle = {
  slug: 'payments-and-applications',
  title: 'Payments, Credits, and Applications',
  category: 'transactions',
  order: 3,
  summary: 'Understand how cash and credits settle open receivables and payables without losing subledger detail.',
  updated: '2026-07-19',
  keywords: ['payment', 'receipt', 'application', 'credit', 'unapplied', 'open item', 'settlement'],
  related: ['sales-workflow', 'purchasing-workflow', 'banking-and-reconciliation'],
  body: `# Payments, Credits, and Applications

Recording cash and settling an open item are related but distinct events. The
payment records the movement of money; an application identifies which invoices,
bills, or credits it settles.

## Customer side

A customer receipt normally debits a bank or clearing account and credits
accounts receivable. Apply the receipt to eligible customer invoices and credits.
If the customer paid more than the selected items, the remainder stays unapplied
and continues to appear in customer detail.

## Vendor side

A vendor payment normally debits accounts payable and credits a bank or clearing
account. Its applications identify the bills and vendor credits included in the
payment. Payment runs help group eligible obligations while preserving each
underlying application.

## Application controls

Applications cannot exceed the available amount on either side. Confirm party,
currency, book, subsidiary, date, and period compatibility. Never use a manual
journal to mark an invoice or bill as paid: the general ledger might move while
the open-item subledger remains outstanding.

## Corrections

If cash was recorded against the wrong party or open item, reverse or amend the
governed record while the relevant period permits it, then create the correct
application. Preserve the relationship to the original evidence.

## Reconciliation

At minimum, reconcile:

- open invoice and bill totals to the AR and AP control accounts;
- unapplied receipts and payments to their detailed party balances;
- payment clearing accounts to transmitted and settled payments; and
- bank-account ledger balances to signed-off bank reconciliations.
`,
}

export const bankingAndReconciliation: DocArticle = {
  slug: 'banking-and-reconciliation',
  title: 'Banking, Matching, and Reconciliation',
  category: 'banking-close',
  order: 1,
  summary: 'Import statement activity, match or categorize lines, build rules, and sign off reconciliations.',
  updated: '2026-07-19',
  keywords: ['bank feed', 'statement', 'import', 'matching', 'categorize', 'bank rule', 'reconciliation', 'cash'],
  related: ['payments-and-applications', 'period-close', 'reconciliation-before-cutover'],
  body: `# Banking, Matching, and Reconciliation

Banking compares external statement evidence with the general ledger. Importing
a statement is not the same as posting a transaction, and matching a line is not
the same as signing off a reconciliation.

## Import statements

Open the bank account and import its supported statement file, or use an
organization-configured connection or scheduled transfer. Confirm the account,
currency, statement dates, and opening and closing balances before processing.

Import history preserves the source and result. Investigate duplicates or gaps
instead of editing statement evidence to fit the ledger.

## Match existing activity

Use **Banking → Match** to pair statement lines with existing ledger activity,
such as customer receipts, vendor payments, transfers, or journals. Match on
amount, date, reference, party, and business context—not amount alone.

## Create missing activity

When a genuine bank transaction has no ledger counterpart, categorize it to the
appropriate account, tax treatment, party, and dimensions. Examples include bank
fees, interest, and direct debits. The resulting accounting transaction remains
separate from the statement line and retains the link.

## Reconciliation rules

Rules can suggest or apply repeatable treatment using controlled conditions.
Keep conditions specific enough to avoid false matches, review rule results, and
archive rules that no longer reflect the bank description or accounting policy.

## Sign off a reconciliation

A reconciliation proves the statement ending balance against the ledger as of a
cutoff date, including identified outstanding items. Resolve unexplained
differences before sign-off. Save supporting evidence and use the signed-off
reconciliation in the period-close package.
`,
}

export const fileCabinet: DocArticle = {
  slug: 'file-cabinet',
  title: 'File Cabinet and Supporting Evidence',
  category: 'administration',
  order: 5,
  summary: 'Organize, search, version, and govern files that support transactions and administrative work.',
  updated: '2026-07-19',
  keywords: ['file cabinet', 'files', 'folders', 'attachments', 'evidence', 'version', 'private folder', 'AP capture'],
  related: ['audit-log', 'purchasing-workflow', 'period-close'],
  body: `# File Cabinet and Supporting Evidence

The **File Cabinet** stores organization files in folders with search, version
history, and governed access. Use it for source documents, close evidence,
imports, exports, templates, and other records that must remain available beyond
one user's device.

## Find and organize files

Browse the folder tree or search across files. Folder, sort, and search state is
kept in the URL. Create a stable folder policy based on business purpose and
retention—not individual employee names.

System folders support product workflows such as AP capture. Treat their purpose
as governed; do not repurpose them for unrelated documents.

## Upload and version

Upload a file to the intended folder and give it a descriptive name. When a file
is revised, add a new version where that preserves continuity instead of creating
unrelated copies such as final-v2-new. The file drawer shows metadata and version
history.

## Access and privacy

File permissions are organization-scoped. Private-folder visibility is narrower
than ordinary File Cabinet access. Do not use a private folder as a substitute
for a properly designed role and retention policy.

## Link evidence to work

Every transaction flyout has an **Attachments** subtab alongside **Details** and
**Audit**. Open that subtab to search and filter the transaction's evidence,
upload or drop files when permitted, download originals, or remove an incorrect
link. PDF and image evidence opens in the built-in preview so a reviewer can
compare it with the transaction without leaving the workflow.

Use the preview's expand control to let the evidence occupy the full flyout, and
use it again to restore the file list. **Open original** launches the governed
download in a separate browser tab when a larger browser view is preferable.

A well-organized cabinet is useful, but evidence is strongest when a reviewer
can move directly from the accounting event to its source.

Keep original bank statements, vendor invoices, customer support, approvals,
imports, reconciliation packages, and issued financial reports according to the
organization's retention policy.
`,
}
