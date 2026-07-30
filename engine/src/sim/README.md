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
