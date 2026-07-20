import type { DocArticle } from '../types'

export const migrationAndCutover: DocArticle = {
  slug: 'migration-and-cutover',
  title: 'Migration and Cutover',
  category: 'integrations',
  order: 1,
  summary:
    'Plan source extraction, mapping, trial loads, reconciliation, parallel operation, final delta, and cutover.',
  updated: '2026-07-20',
  keywords: [
    'migration',
    'implementation',
    'cutover',
    'parallel run',
    'opening balance',
    'history',
    'mapping',
    'delta',
  ],
  related: ['quick-start', 'reconciliation-before-cutover', 'data-imports'],
  body: `# Migration and Cutover

A migration is complete only when users can perform their work and the new books
are proven. Loading rows is one step in a controlled cutover.

## Choose the history strategy

Agree on one of these patterns before building mappings:

- **Full transaction history** supports detailed comparison and long-term drilldown.
- **Comparative history plus open items** supports prior-period reporting with a
  smaller operational load.
- **Opening balances plus open items** is fastest but keeps most history in the
  source archive.

Define which source remains authoritative for every date range and record type.
Do not mix approaches informally.

## Inventory the source

List legal entities, books, currencies, periods, accounts, dimensions, tax,
customers, vendors, employees, items, projects, bank accounts, open documents,
applications, fixed assets, inventory, attachments, approvals, and custom data.
Record row counts, date bounds, and known data-quality exceptions.

## Map and cleanse

Create explicit, reviewable mappings for every account, dimension, status,
transaction type, tax code, currency, and master record. Preserve stable source
identifiers. Merge duplicates and resolve invalid references in a repeatable
transformation—not by hand after each load.

## Trial loads

Run repeated imports into a non-production organization or controlled migration
scope. Time each stage, keep diagnostics, and make the process idempotent so a
retry does not create duplicates.

Test complete workflows on the migrated data: find a source transaction, inspect
its OpenBooks record and ledger entry, apply cash, run aging, reconcile a bank
account, and produce statements.

## Migrate source attachments

For a **NetSuite** connection, install or update the OpenBooks extraction bridge,
then choose **Sync attachments** on the connection card. The background run
inventories Files-subtab attachments on vendor bills and expense reports plus
receipt images attached to individual expense lines. It imports supported PDF
and image evidence into the tenant's configured object storage and links each
file to the matching transaction without duplicating files or links on reruns.

Review the **Attachments** run in **Recent runs**. A failed file prevents the run
from reporting success; correct source permissions, unsupported content, or file
size issues and rerun it. Open a migrated transaction and use its **Attachments**
subtab to preview, download, or expand the evidence within the flyout.

## Parallel operation

For a hard accounting cutover, run both systems through representative cycles.
Compare account-by-period activity, trial balances, subledgers, tax, cash,
projects, and issued reports. Investigate differences to a documented conclusion.

## Final cutover

1. announce and enforce the source posting cutoff;
2. take the final backup or immutable export;
3. run the final delta or capture;
4. repeat every reconciliation gate;
5. obtain accounting and operational approval;
6. enable production entry in OpenBooks; and
7. retain the source read-only according to policy.

Prepare a rollback decision window in advance. Rollback means returning to a
clearly authoritative system, not entering some activity in each.
`,
}

export const reconciliationBeforeCutover: DocArticle = {
  slug: 'reconciliation-before-cutover',
  title: 'Reconciliation Before Cutover',
  category: 'integrations',
  order: 2,
  summary: 'Build the minimum evidence package that proves migrated books and subledgers before go-live.',
  updated: '2026-07-19',
  keywords: [
    'reconciliation',
    'validation',
    'trial balance',
    'account activity',
    'subledger',
    'control totals',
    'cutover gate',
  ],
  related: ['migration-and-cutover', 'financial-reports', 'banking-and-reconciliation'],
  body: `# Reconciliation Before Cutover

Do not approve cutover from a single grand total. A balanced ledger can still
contain wrong accounts, periods, parties, dimensions, currencies, or open items.

## Ledger gates

Compare source and OpenBooks for every migrated book, subsidiary, and currency:

- trial balance by account at the opening date and every comparative period end;
- debit-positive account activity by posting period;
- journal count and amount by source transaction type; and
- retained earnings and current-year income roll-forward.

Every difference needs a source record, mapping explanation, approved conversion
entry, or defect resolution.

## Subledger gates

Reconcile AR and AP aging by party and open transaction, including credits and
unapplied cash. Reconcile bank accounts, fixed assets and accumulated
depreciation, inventory quantity and value, tax balances, projects, revenue
schedules, and intercompany balances where enabled.

Control-account totals must agree with the supporting subledger. Never repair a
subledger difference with an unexplained control-account journal.

## Record-level sampling

Select samples across old and recent periods, currencies, entities, high and low
values, credits, reversals, taxes, closed periods, and custom dimensions. Trace
each sample from source evidence to the OpenBooks transaction, ledger entry,
subledger report, and financial statement.

## Operational gates

Have real users perform their normal creation, approval, posting, payment,
reconciliation, reporting, and correction tasks with production-like roles.
Confirm number sequences, PDFs, exports, integrations, notifications, and
close evidence.

## Sign-off package

Retain extracts or hashes, mapping versions, load logs, exceptions, report
parameters, reconciliations, sample results, approvals, timestamps, and the exact
code or connector version used. Name the accountable approver for accounting,
operations, security, and cutover.

Cutover is blocked while an unexplained financial difference remains, even if it
appears immaterial. Materiality is an accounting judgment applied to an explained
difference—not a substitute for diagnosis.
`,
}
