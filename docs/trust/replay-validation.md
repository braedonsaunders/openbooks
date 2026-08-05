# Delete-and-rebuild replay validation (preview)

OpenBooks includes a preview harness for rebuilding a synthetic company's books
from a declared simulator profile and seed, then comparing aggregate results to
a snapshot produced by the same simulator run. It is useful regression and
rebuild-integrity evidence. It is not an independent accounting oracle, a
published production-data result, or proof that every derived figure is a pure
function of fully captured source events.

## What the harness checks

1. **Generate synthetic source activity.** The deterministic business simulator
   provisions a tagged organization and exercises commercial documents,
   settlements, job costing, payroll, and closes.
2. **Capture a same-system snapshot.** The exporter records the trial balance,
   open AR/AP by party, and per-project cost, billed, and margin, together with
   neutral semantic dictionaries and the events needed by the replay harness.
3. **Rebuild in a fresh synthetic organization.** Supported documents and
   payments pass through their native posting paths. Pure-GL simulator output is
   replayed as journals because the upstream domain event is not yet represented
   in this corpus format.
4. **Compare exactly.** Aggregate comparisons use ledger precision with no
   tolerance and the rebuilt organization must pass native integrity checks.

The golden snapshot comes from OpenBooks itself. A clean comparison therefore
detects regressions and incomplete rebuilds; it does not independently establish
that the original accounting treatment was correct. Native event-by-event GL
projection comparison is also not implemented yet, so offsetting errors could
escape the aggregate comparison.

## Safety boundary

Both `OPENBOOKS_SIM=1` and a dedicated database whose name contains
`sim`, `test`, `sandbox`, or `scratch` are mandatory. The exporter also verifies
that the source organization carries the simulator tag before it reads names,
memos, descriptions, or document numbers. Do not point these commands at a
shared or production database.

Private migration and reconciliation work helped shape this methodology, but
customer identities, account-derived metrics, source-system details, and
private findings are deliberately not publication evidence. They do not belong
in a public source tree or Git history.

## Current publication status

`corpus/replay/` currently contains documentation only; no synthetic dataset is
published or exercised in CI. Do not cite a public replay result until a corpus
has been generated on isolated infrastructure, reviewed as synthetic, checked
in, and made a required CI job.

To generate local preview evidence on an isolated database:

```sh
OPENBOOKS_DB_URL=postgres://.../openbooks_replay_test \
OPENBOOKS_SIM=1 npm -w engine run harness:replay -- build \
  --profile general-contractor --seed public-1 --name <name>

OPENBOOKS_DB_URL=postgres://.../openbooks_replay_test \
OPENBOOKS_SIM=1 npm -w engine run harness:replay -- rebuild corpus/replay/<name>
```

The report distinguishes:

| Outcome | Meaning |
| --- | --- |
| Native replay | The event re-posted through its native document or payment path. |
| GL fallback | Native replay failed and the original GL projection was copied into a diagnostic journal. Every fallback makes the run fail. |
| Hard failure | Neither the native path nor diagnostic projection could be posted. |

Pure-GL simulator events are journal inputs rather than native domain-event
replays. They remain a declared limitation even when the run passes.

## Sibling evidence

- `docs/trust/conformance-matrix.md` maps published accounting requirements to
  executable fixtures and declared gaps.
- `engine/src/harness/differential` compares a neutral corpus with a separate
  reference ledger.
- `engine/src/sim` exercises invariant-based synthetic business scenarios,
  including long-duration endurance runs.
