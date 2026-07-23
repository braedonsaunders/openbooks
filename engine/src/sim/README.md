# OpenBooks Business Simulation Harness

A deterministic, resumable simulator that runs **realistic multi-team businesses
over time** through the *real* OpenBooks accounting engine — bills arrive and get
paid, projects run, invoices go out and get collected, months close — while a
team of **LLM personas** operate the business like humans and an **invariant
oracle** turns any product defect into a hard halt.

This is a *hybrid* harness:

- A **seeded generator** injects each day's raw economic reality (bills arriving,
  work becoming billable, customer money landing). Deterministic per `(profile, seed)`.
- A **team of LLM personas** — AP clerk, AR specialist, controller, CFO — makes
  the judgment calls (approve, dispute, prioritize, apply cash, reconcile, close),
  driven as Claude Code subagents. See `personas/`.
- The **operator** (Claude Code) supervises: on any invariant break or persona-
  reported bug, it **stops and fixes the product**, then deterministically
  resumes. See `OPERATOR.md`.

Nothing here writes ledger rows directly — every action flows through the posting
kernel, the payment-application engine, and the close/period-lock engine.

## Quick start

```bash
# 1. Throwaway Postgres (never point this at real data).
docker compose -f engine/src/sim/docker-compose.yml up -d

# 2. Load the OpenBooks schema into openbooks_sim (same schema as a dev DB).
#    Apply the repo's migrations against OPENBOOKS_DB_URL below.

# 3. Provision a company for a 6-month run.
export OPENBOOKS_SIM=1
export OPENBOOKS_DB_URL=postgres://openbooks:openbooks@localhost:5433/openbooks_sim
npm --prefix engine run sim -- provision \
  --profile general-contractor --seed 1 --start 2026-01-01 --end 2026-06-30
```

`provision` prints a `runDir`. From there, follow **`OPERATOR.md`** — the daily
loop (`day-start` → dispatch persona subagents → `day-end`) and the stop-and-fix
protocol.

## Safety

The CLI refuses to run unless **both**:

- `OPENBOOKS_SIM=1` is set, and
- the database name contains `sim`/`test`/`sandbox`/`scratch`.

The harness provisions and (on `reset`) wipes whole orgs, so this interlock is not
optional.

## CLI

| Command | Purpose |
|---|---|
| `provision --profile --seed --start --end` | Stand up an org for a run |
| `day-start <RUN>` | Advance a day, inject seeded events, cheap checks |
| `observe <screen> <RUN>` | Read a screen (`ap-inbox`, `ap-open`, `ar-inbox`, `ar-receipts`, `ar-aging`, `trial-balance`, `period-status`) |
| `act <action> <RUN> --flags` | Do work (`post-bill`, `dispute-bill`, `pay-vendor`, `issue-invoice`, `apply-receipt`, `post-journal`, `close-month`) |
| `day-end <RUN>` | Run the oracle; HALT on any invariant failure |
| `verify <RUN>` | Re-run the oracle without advancing (confirm a fix) |
| `status` / `coverage <RUN>` | Run state / capability coverage |
| `reset <RUN>` | Wipe the run's org |
| `list-profiles` | Available industry profiles |

## Layout

```
sim/
  PLAN.md            the design + roadmap
  OPERATOR.md        the stop-and-fix runbook (start here to drive a run)
  README.md          this file
  clock.ts           (../clock.ts) injectable simulated clock
  rng.ts             seeded, splittable, serializable PRNG
  manifest.ts        resumable run state + world snapshot + date helpers
  db-guard.ts        the sim-database interlock
  profiles/          industry profiles (config; add your own here)
  world.ts           org provisioning + reset
  generator.ts       the seeded daily event backbone
  observe.ts         read-only screens
  ops.ts             the action surface (routes through the real engine)
  activities/        the create-and-post document primitive
  invariants/        the oracle + defect-bundle emitter
  runner.ts          day-loop primitives (day-start / day-end / verify)
  cli.ts             the command surface
  personas/          LLM persona playbooks (AP, AR, controller, CFO)
```

## Determinism

The *environment* is deterministic and seeded (Tier A: same `(profile, seed)` →
same raw event stream, checkpointed by value). The *humans* are the LLM — realism
comes from their judgment; a full decision log lives in the run dir. Byte-
identical structural replay (Tier B, via the sandbox UUID-rebase engine) is an
optional future add. See `PLAN.md`.
