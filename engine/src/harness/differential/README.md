# Differential-corpus harness

Cross-implementation differential testing for the accounting kernel. One
neutral, published transaction corpus is replayed through the REAL OpenBooks
pipeline (document insert → approval boundary → posting kernel →
payment-application engine) and independently computed by a deliberately tiny
reference ledger. The two results are diffed penny-for-penny — no tolerance,
one cent fails.

This complements the two sibling evidence systems:

- `engine/src/harness/ledger-parity` — the same economic events driven through
  OpenBooks and a pinned ERPNext site, compared per lifecycle checkpoint.
- `engine/src/conformance` — published accounting-standards requirements
  encoded as executable fixtures.

The differential harness adds the third leg: an **independent oracle**. The
reference ledger (`reference-ledger.ts`) imports NOTHING from the engine — not
even its money utilities — and restates the posting semantics from the spec
below, so a defect shared with the product cannot hide in the comparison.

## The corpus contract

A corpus (`corpus/differential/corpus-<seed>.json` at the repo root) is a
self-contained JSON document: an account dictionary (semantic keys), a party
dictionary (roles), and a chronological event stream. Amount conventions:

- Journals carry SIGNED amounts (debit positive, credit negative) that sum to
  zero. Commercial documents carry POSITIVE line amounts; direction is a fixed
  function of document kind:

  | kind | line legs | control leg (open item) |
  | --- | --- | --- |
  | customer_invoice | CR each line | DR `ar` (+) |
  | customer_credit | DR each line | CR `ar` (−) |
  | vendor_bill | DR each line | CR `ap` (−) |
  | vendor_credit | CR each line | DR `ap` (+) |
  | expense_report | DR each line | CR `employeePayable` (−) |
  | customer_payment | DR `bank` | CR target control |
  | vendor_payment | CR `bank` | DR target control |

- A payment's control account is its TARGETS' control account; one payment may
  not settle items on different control accounts. Allocations reduce the
  target's open magnitude toward zero and may never exceed it.
- Every amount must parse as an exact two-decimal value. There is no rounding
  tolerance anywhere.

`expected-<seed>.json` beside the corpus is the published comparison contract:
the trial balance per semantic account key and the signed open balance per
party per subledger side. Any accounting system that can import the corpus
should reproduce those balances exactly; the corpus + expected pair is designed
to be usable by other products' adapters, not just OpenBooks.

## Commands

```sh
# Deterministic generation — same seed, byte-identical corpus + expected file.
npm -w engine run harness:differential -- generate --seed obk-1 --start 2026-01-01 --end 2026-06-30

# Oracle-only validation of a corpus (no database).
npm -w engine run harness:differential -- check ../corpus/differential/corpus-obk-1.json

# Full replay through the real product (provisions a disposable sim-tagged org).
OPENBOOKS_SIM=1 npm -w engine run harness:differential -- replay ../corpus/differential/corpus-obk-1.json
```

`replay` compares three things and exits non-zero unless all pass:

1. Trial balance by semantic account key — OpenBooks vs reference, exact.
2. Open balances per party per side (AR/AP aging roots) — exact.
3. OpenBooks' own native integrity invariants (global balance, per-entry
   balance, document-total ↔ control-account tie-out) via the sim oracle.

Reports land in `.local/differential/` (git-ignored). A passing run wipes its
replay org through the guarded sim teardown; a failing run retains the org for
investigation and prints its id.

## What the generator covers

Routine daily AR/AP traffic plus the cases that break naive implementations:
multi-line documents with odd cents that must cross-foot exactly, partial
payments and second tranches, standalone credit memos, vendor payments batched
per party per day, employee expense reports settled through the
employee-payable control, month-end accruals with next-month reversals,
monthly depreciation, and explicit one-cent rounding-stress journals.

Deliberately out of scope for corpus v1 (each is exercised by the sibling
harnesses): multi-currency, tax engines, credit-memo applications,
inventory/COGS flows, and project dimensions. Extend the schema before
widening the generator — the corpus format is versioned (`schemaVersion`).

## Evidence protocol

A difference is evidence, never an annoyance to be tolerated away:

1. If the product is wrong — fix the product and add a regression test.
2. If the oracle mis-states the spec — fix the spec HERE and in the oracle,
   and say so in the commit message. The spec is the published contract; it
   only changes with a written rationale.
3. Never widen a tolerance. There is none.

First live run of this harness surfaced a real product defect: expense-report
control lines on the (preset-standard) `liability_current_other` employee
payable account were never marked as open items, so reimbursements could not
settle through the payment engine — fixed in `posting.ts`
(`resolveOpenItemAccounts`) and `payments.ts` (control-account derivation from
allocation targets), with a regression test in
`engine/src/expense-report-open-item.integration.test.ts`.
