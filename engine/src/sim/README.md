# Business simulation harness

The simulation harness exercises OpenBooks through the real database, posting
engine, subledgers, close controls, and invariant checks. It is intended for
repeatable engineering verification—not for seeding production companies.

The harness can provision a synthetic company, advance a deterministic clock,
generate business events, run the built-in autopilot, and stop with a defect
bundle when an invariant fails.

## Safety

The harness refuses to run unless:

- `OPENBOOKS_SIM=1` is set; and
- `OPENBOOKS_DB_URL` points to a database whose name is clearly isolated for
  simulation.

Never point it at a production or shared development database.

## Run

```bash
export OPENBOOKS_SIM=1
export OPENBOOKS_DB_URL=postgres://openbooks:openbooks@localhost:5433/openbooks_sim

npx tsx scripts/bootstrap.ts

# Create a deterministic run directory.
npm --prefix engine run --silent sim -- provision \
  --profile general-contractor \
  --seed 1 \
  --start 2026-01-01 \
  --end 2026-02-28

# Use the runDir printed by provision.
npm --prefix engine run --silent sim -- run <runDir>
npm --prefix engine run --silent sim -- coverage <runDir>
```

Available commands and flags are defined by `cli.ts`. The CI smoke workflow
demonstrates the supported non-interactive path.

## Evidence

Each run writes its state beneath `engine/sim-runs/`, which is intentionally
git-ignored. When an invariant fails, the harness records a defect bundle with
the run context needed to reproduce the failure.

The invariant oracle checks accounting properties such as:

- balanced journal entries;
- subledger-to-general-ledger agreement;
- payment and open-item consistency;
- period-close immutability;
- inventory valuation consistency; and
- deterministic replay.

Simulation coverage supplements unit, database-integration, and browser tests.
It is not an independent audit or a substitute for review by qualified
accounting and security professionals.

## Endurance mode (decade runs)

`endurance` drives the same day loop over an arbitrarily long window — the
published target is ten fiscal years — and layers on what only a long horizon
proves:

```sh
OPENBOOKS_SIM=1 npm run sim -- provision --profile general-business --seed decade-1 --start 2027-01-01 --end 2036-12-31
OPENBOOKS_SIM=1 npm run sim -- endurance <runDir>
OPENBOOKS_SIM=1 npm run sim -- endurance-report <runDir>   # re-run the finale alone
```

On top of the standard oracle (which already closes every month and probes
closed-period immutability at each close), endurance adds:

- **Continuous adversarial probes** (`ops-adversarial.ts`) on a seeded
  cadence: backdating journals into periods closed YEARS earlier, raw SQL
  edits of posted documents' financial identity, over-application beyond an
  item's open balance, reversal-symmetry checks, and void/recreate cycles.
  A probe the kernel fails to refuse halts the run exactly like a broken
  balance.
- **Boundary coverage by construction**: ten Dec-31 year-ends and every leap
  day in the window are ordinary business days. (All simulated timestamps are
  UTC dates; the kernel resolves periods from document dates, so civil-time
  DST transitions have no ledger meaning and are deliberately not simulated.)
- **A final GL-regeneration sweep**: every posted document in the decade is
  regenerated through the kernel in mirror scope and must come back
  `changed: false`, with the trial balance byte-identical before and after.

The finale writes `<runDir>/endurance/endurance-report.json`: days simulated,
months closed, leap days and year-ends crossed, per-probe counts, and the
sweep result. The first endurance smoke run halted on simulated day 7: the
posted-edit probe found that a posted document HEADER's financial identity
was raw-SQL mutable (the journal side was always guarded) — closed by
the posted-document financial guard in `schema/migrations/generated/0001_baseline.sql`.
