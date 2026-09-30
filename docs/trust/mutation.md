# Mutation testing the financial engine

A mutant is a small, behavior-changing edit to engine source (a flipped sign,
an inverted guard, truncation instead of half-away rounding). The suite kills
a mutant when at least one test fails on it. The **mutation score** per file
is killed ÷ measured over a sampled mutant set. A low score does not mean the
code is wrong — it means the suite cannot see whole classes of behavior
change there, so a future regression in that code would also pass green.

## Recorded measurement

The checked-in report was measured on `1d6e4fec443071149393ad5545e13fdc1a55d311` at
`2026-09-20T09:57:31.665Z` in the database partition. These are historical
results, not evidence that later changes or newly extracted helpers are covered.
A fresh scoped run reports its own source commit, selected files, baseline counts
and partition; it does not replace or ratify this complete historical measurement.

| target | score | measured |
| --- | --- | --- |
| engine/src/money/money.ts | 96.0% | 25 |
| engine/src/ledger/posting-rules.ts | 100.0% | 25 |
| engine/src/ledger/posting-tax-policy.ts | 84.0% | 25 |
| engine/src/ledger/posting-effects.ts | 100.0% | 25 |
| engine/src/sync/applications.ts | 40.0% | 25 |
| engine/src/payments-core/payment-document-lock.ts | 100.0% | 3 |
| engine/src/payments/payment-queries.ts | 73.3% | 15 |
| engine/src/payroll/run-calculation-evidence.ts | 100.0% | 5 |
| engine/src/payroll/run-calculation.ts | 92.9% | 14 |
| engine/src/payroll/run-earning-lines.ts | 72.0% | 25 |
| engine/src/payroll/canada/t4127.ts | 60.0% | 25 |
| engine/src/payroll/canada/compute-statutory.ts | 87.0% | 23 |
| engine/src/payroll/canada/employer-levies.ts | 60.0% | 25 |
| engine/src/payroll/us/pub15t.ts | 96.0% | 25 |
| engine/src/payroll/us/withholding.ts | 64.0% | 25 |
| engine/src/payroll/us/compute-statutory.ts | 65.2% | 23 |
| engine/src/tax/tax.ts | 84.0% | 25 |
| engine/src/tax-returns/return.ts | 88.0% | 25 |
| engine/src/consolidation/consolidation.ts | 80.0% | 25 |
| engine/src/assets/depreciation-schedule-build.ts | 36.0% | 25 |
| engine/src/ledger/posting-document.ts | 100.0% | 1 |
| engine/src/ledger/posting-prepare.ts | 96.0% | 25 |
| engine/src/ledger/posting-commit.ts | 100.0% | 25 |
| engine/src/ledger/posting-replay.ts | 52.0% | 25 |
| engine/src/ledger/posting-projection.ts | 100.0% | 9 |
| engine/src/ledger/posting-dispatch.ts | 88.0% | 25 |
| engine/src/ledger/posting-accounts.ts | 100.0% | 19 |
| engine/src/ledger/posting-provider-tax.ts | 92.0% | 25 |
| engine/src/ledger/posting-subsidiaries.ts | 100.0% | 20 |
| engine/src/ledger/posting-period.ts | 95.5% | 22 |
| engine/src/journal/posting-invariants.ts | 76.5% | 17 |
| engine/src/payments/settlement-policy.ts | 68.0% | 25 |

Survivor locations belong to that measured tree. Follow extracted code to its
current implementation before reproducing a survivor, and use the database
partition for reconciliation and persisted depreciation scheduling.

A survivor is a missing regression signal, not proof that the production result
is incorrect. An equivalent mutant can survive without changing observable
behavior; classify it from a realistic execution before adding an assertion.

## Running it

```bash
npm run test:mutation -- --target money.ts --sample 10   # one file, quick
npm run test:mutation                                    # curated default: sample 25, 240s/mutant, unit unless OPENBOOKS_DB_URL is set
```

Flags: `--target <substring>` (repeatable), `--sample N` (`0` = all mutants),
`--timeout-secs N`, `--report-dir <dir>`, `--unit-only`, `--list-targets`,
`--max-per-operator N`, `--write-checked-in` (refresh the ratified report).
Reports land as JSON + Markdown in `.local/mutation/` by default.

How it works: the runner copies tracked worktree files to a temp dir with
symlinked `node_modules` (worktree source is never mutated), runs the mapped
tests unmutated (a red baseline blocks the target; an all-skip baseline
reports the target skipped — typically DB-backed files without a database),
then runs each sampled mutant the same way. Verdicts: killed / survived /
timed-out (counts as killed, reported separately) / skipped (nothing
executed) / error (does not parse — excluded from the score, never killed).

## The floor (ratchet)

`engine/src/harness/mutation/mutation-floor.json` records the ratified score
per target. `mutation-floor.test.ts` (runs in the unit suite) fails when a
measured score drops below its floor, when a target goes unmeasured, when a
baseline is red, or when config/report/floor drift apart. Floors move only by
explicit commit of report + floor together; ratifying a higher floor is an
explicit reviewed decision. Sampling is seeded and deterministic, so the
same code + config +
sample always yields the same mutant set — a floor failure means the code or
its coverage changed, never dice.

## Anti-false-green proofs

- `harness-selfcheck.test.ts` plants the exact default-pipeline formatMoney
  guard-flip mutant into a temp copy of `money.ts`, runs the real
  `money.test.ts` against it, and asserts the kill (pristine must pass first).
- The nightly CI job (`mutation.yml`, non-blocking, uploads the report) runs
  with a database so DB-only targets are measured there.
- Error verdicts (unparseable mutants, currently ~4% — `/` flips inside regex
  literals, which the source masker deliberately does not parse) are excluded
  from the score and listed separately in every report.

## Known limitations

- Generation is line-oriented text search, not parsing: generic angle
  brackets are skipped by a documented spaced-comparison heuristic, regex
  literals are not masked (caught by the syntax gate instead).
- `early-return-before-write` fires only under a provable void return type.
- Scores are sample estimates; `--sample 0` runs the full set for disputes.
- Unit-mode scores understate files whose covering tests need a database —
  read the `n/a (DB-only)` rows as unmeasured, not as zero.
