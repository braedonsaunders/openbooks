# OpenBooks public verification corpora

Published, reproducible inputs and expected outputs for verifying accounting
correctness — OpenBooks' own, or any other system's. Everything in this
directory is synthetic, deterministically generated from a seed, and free to
use.

| Directory | What it is | Harness |
| --- | --- | --- |
| `differential/` | Neutral transaction corpus + reference-ledger expected balances. Replay it through any accounting system and compare trial balance and per-party open balances, penny-for-penny. | `engine/src/harness/differential` |
| `replay/` | A full synthetic construction company (jobs, five billing methods, field labor, retainage) with golden per-project cost/billed/margin rollups, for delete-and-rebuild replay validation. | `engine/src/harness/replay` |

Regeneration is deterministic — the same seed produces byte-identical files:

```sh
npm -w engine run harness:differential -- generate --seed obk-1 --start 2026-01-01 --end 2026-06-30
```

The comparison contract has **no rounding tolerance**. A one-cent difference is
a failure, and a difference is evidence to classify (product defect, spec
defect, or documented semantic difference) — never something to tolerate away.
