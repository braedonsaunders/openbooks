# Mutation testing the financial engine

A mutant is a small, behavior-changing edit to engine source (a flipped sign,
an inverted guard, truncation instead of half-away rounding). The suite kills
a mutant when at least one test fails on it. The **mutation score** per file
is killed ÷ measured over a sampled mutant set. A low score does not mean the
code is wrong — it means the suite cannot see whole classes of behavior
change there, so a future regression in that code would also pass green.

## Current scores (sample 25/target, unit mode, git `875f2176f`)

| target | score | measured | notes |
| --- | --- | --- | --- |
| engine/src/payroll/us/pub15t.ts | 76.0% | 25 | strongest unit coverage in scope |
| engine/src/tax.ts | 48.0% | 25 | |
| engine/src/tax-return.ts | 43.5% | 23 | |
| engine/src/money.ts | 39.1% | 23 | survivors in precision validation + div() rounding |
| engine/src/payroll/canada/t4127.ts | 37.5% | 24 | |
| engine/src/posting.ts | 34.8% | 23 | unit mode; DB run pending |
| engine/src/posting-effects.ts | 20.0% | 25 | backoff math covered; claim guards are not |
| engine/src/depreciation.ts | 17.4% | 23 | 47 baseline tests execute — breadth without teeth |
| engine/src/payroll-run.ts | 16.0% | 25 | partial unit signal; DB run pending |
| engine/src/payments.ts | 8.3% | 24 | allocation math thinly covered in unit mode |
| engine/src/payroll/us/withholding.ts | 8.3% | 24 | certificate/rate guards survive |
| engine/src/sync/applications.ts | 0.0% | 23 | only 2 unit tests execute; rest need a DB |
| engine/src/consolidation.ts | n/a | 0 | DB-only; nightly measures it |
| engine/src/payroll/canada/compute-statutory.ts | n/a | 0 | DB-only; pilot run executed 25/25 baseline tests with 2 survivors at line 127 (boundary `210->211`, `===`→`!==`) |
| engine/src/payroll/canada/employer-levies.ts | n/a | 0 | DB-only; pilot run executed 2/2 baseline tests |
| engine/src/payroll/us/compute-statutory.ts | n/a | 0 | DB-only |

Top surviving mutants per file (the concrete test gaps) are listed in
`engine/src/harness/mutation/mutation-report.json` under `topSurvivors`, and
in full in the nightly `mutation-report` artifact. Loudest examples from the
ratified run: `money.ts` div() tolerates truncation replacing half-away
rounding; `posting.ts:610` reverse-charge `!==` flipped to `===` survives the
unit set; `sync/applications.ts` flips anywhere survive; `depreciation.ts`
manual-method guard negation survives.

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
explicit commit of report + floor together; the coordinator decides when to
raise. Sampling is seeded and deterministic, so the same code + config +
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
