# OpenBooks ↔ ERPNext GL parity harness

This harness drives the same economic events through the real OpenBooks posting
kernel and a pinned ERPNext site, then compares exact functional-currency GL
impact after every lifecycle checkpoint.

It does not treat ERPNext as an unquestionable accounting specification.
Differences are evidence to classify. OpenBooks controls such as immutable posted
history, controlled reversals, exact decimals, tenant isolation, and audit
evidence remain mandatory even where ERPNext uses cancellation or destructive
amendment semantics.

## Canonical comparison contract

- Signed amount is debit-positive, four-decimal functional currency.
- Source ids, generated document numbers, GL row order, and descriptive memos
  are ignored.
- Accounts are compared through an explicit semantic map.
- The canonical key supports party, project, and cost-center dimensions.
  Project-aware scenarios currently compare the project dimension explicitly;
  party/control-subledger and cost-center mappings remain explicit pending
  coverage rather than being silently discarded from those scenarios.
- Every source voucher and every canonical snapshot must independently balance.
- There is no rounding tolerance. A one-cent difference fails.
- Draft, submit/post, allocation, amendment, cancellation/reversal, and period
  lock checkpoints are separate evidence records.

## Exhaustiveness rule

`matrix.ts` is the scope register. “Exhaustive parity” may be claimed only after
every direct or semantic row has passing evidence at all listed checkpoints and
each product-specific row has a passing native invariant suite. An unsupported
or unclassified capability is a coverage failure, never an implicit pass.

Resolved discoveries remain in evidence. For example, ERPNext rounded a CAD
28.25 return to 28.00 through its Round Off account until the comparison
document explicitly set `disable_rounded_total=1`; OpenBooks preserves the exact
document total. The failing observation and the passing configured rerun are
both retained.

## Runtime isolation

- OpenBooks uses the repository's existing local-dev configuration and its
  remote PostgreSQL/Redis services. The harness creates one dedicated tenant.
- ERPNext runs in the `openbooks-erpnext-parity` Docker Compose project.
- Local credentials, manifests, and evidence live under `.local/`, which is
  excluded from version control.

## Commands

```sh
npm -w engine run harness:ledger-parity -- provision
npm -w engine run harness:ledger-parity -- status
npm -w engine run harness:ledger-parity -- run-journal
npm -w engine run harness:ledger-parity -- run-core
npm -w engine run harness:ledger-parity -- run-secondary
npm -w engine run harness:ledger-parity -- run-document-corrections
npm -w engine run harness:ledger-parity -- run-depreciation
npm -w engine run harness:ledger-parity -- run-asset-lifecycle
npm -w engine run harness:ledger-parity -- run-fx-revaluation
npm -w engine run harness:ledger-parity -- run-fx-settlement
npm -w engine run harness:ledger-parity -- run-revenue-recognition
npm -w engine run harness:ledger-parity -- run-project-recognition
npm -w engine run harness:ledger-parity -- run-consolidation
npm -w engine run harness:ledger-parity -- run-income-tax-provision
npm -w engine run harness:ledger-parity -- run-sync-corrections
npm -w engine run harness:ledger-parity -- run-tax
npm -w engine run harness:ledger-parity -- run-posting-rules
npm -w engine run harness:ledger-parity -- run-inventory
npm -w engine run harness:ledger-parity -- run-inventory-advanced
npm -w engine run harness:ledger-parity -- run-inventory-advanced-native
npm -w engine run harness:ledger-parity -- run-psp-native
npm -w engine run harness:ledger-parity -- run-banking-native
npm -w engine run harness:ledger-parity -- run-gl-replay-native
npm -w engine run harness:ledger-parity -- report
npm -w engine run harness:ledger-parity -- matrix
```

`report` writes `.local/erpnext-parity/coverage-report.json`. It includes every
function-level operation in `operations.ts`, the evidence files attached to
each operation, independent balance checks, and an `exhaustive` flag. The flag
must remain false while any operation is partial or pending.

## Implemented comparison slices

- Manual journals.
- Sales and purchase invoices.
- Customer and supplier payments, allocation, unallocation, and outstanding
  balances, including customer/supplier attribution on AR/AP control lines.
- Sales and purchase credits/returns.
- Bank transfers, checks, and deposits.
- Employee expenses, card charges, and card refunds through documented
  semantic Journal Entry equivalents.
- Project-charge account, amount, project-dimension, and reversal comparison
  through a semantic Journal Entry equivalent.
- FIFO inventory receipt, issue, transfer, quantity checkpoints, and
  compensating reversal arithmetic through Stock Entry equivalents.
- Exclusive and inclusive standard HST on sales and purchases, including a
  half-cent rounding edge and taxed sales/purchase returns.
- Ordered compound tax on sales and purchases, purchase withholding, and
  reverse-charge input/output tax with no supplier-settlement distortion.
- Append-only document correction through exact original, reversal, replacement,
  replacement reversal, immutable lineage, and retry/concurrency checkpoints.
- Straight-line depreciation schedule construction, each periodic posting, and
  repeat-run idempotency.
- Asset registration, impairment, cancellation, write-off, restoration, and
  lifecycle idempotency. Carrying-value comparison uses an explicit semantic
  map where ERPNext posts remeasurement to the asset account and OpenBooks
  preserves its accumulated-depreciation policy.
- Foreign-currency invoice, partial and final settlement at different rates,
  realized FX, foreign/base outstanding balances, payment cancellation, and
  invoice cancellation.
- Monetary-balance FX revaluation, exact next-period reversal, and idempotency.
- Deferred-revenue invoice posting, exact schedule construction, every
  recognition period, repeat-run idempotency, recognized-revenue credit and
  credit cancellation, and append-only recognition plus invoice cancellation.
- Exactly-once project labor-to-WIP, project-dimensional overhead absorption,
  direct project reclassification, equipment cost/recovery with retained unit
  attribution, and every compensating reversal. ERPNext uses Project-tagged
  Journal Entries as the documented semantic posting equivalent.
- Separate parent, child, and elimination legal entities; linked intercompany
  source journals; automatic due-to/due-from elimination; 80%-owned subsidiary
  acquisition, goodwill, NCI equity/income; and append-only rerun replacement.
- Bank-statement import dedupe, exact transaction-currency matching, exclusion
  evidence, sign-off concurrency, tenant isolation, and immutable reconciliation
  metadata through the OpenBooks-native invariant suite.
- Historical GL replay is idempotent for non-financial edits and fails
  atomically for any base, transaction-currency, FX, account, dimension, or
  posting-scope change; append-only correction parity remains explicitly open.
- Draft/no-GL, submit/post, and cancel/controlled-reversal lifecycle checks for
  the operations above.

Income-tax provision, sync source deletion/true-up corrections, and both
controlled validation-repair paths are covered by retained evidence. The
operation registry has no partial or pending entries. `report` still computes
that result from the registry, matrix, and evidence directory on every run; this
paragraph is descriptive and is not allowed to override a failing report.

The matrix also records ERPNext-only manufacturing, payroll, loan, and
subscription doctypes. They are an explicit product-scope difference, not an
implicit OpenBooks pass. “Exhaustive” means every declared OpenBooks GL mutation
path is either directly compared, compared through a documented semantic
equivalent, or covered by a native invariant suite. It does not claim that
OpenBooks implements every ERPNext application module.
