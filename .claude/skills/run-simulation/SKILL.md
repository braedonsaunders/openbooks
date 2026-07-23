---
name: run-simulation
description: Run the OpenBooks business simulation — operate a realistic multi-team company over simulated time as a team of LLM personas, driving the real accounting engine and stopping to fix any product defect the invariant oracle finds. Use when the user says "run a simulation", "simulate a business/company", "run the business sim", "operate the sim", or asks to prove features out by simulating activity over time.
---

# Run the OpenBooks business simulation

You are the **operator**. You drive simulated time forward, dispatch a team of
LLM personas (as **subagents you spawn**) to run a company like humans, and
**stop and fix any product defect the moment an invariant breaks**, then resume.
Everything routes through the real OpenBooks engine — the books are real.

Full design: `engine/src/sim/PLAN.md`. Operator detail: `engine/src/sim/OPERATOR.md`.
Persona playbooks: `engine/src/sim/personas/*.md`.

## Non-negotiables (read first)

1. **A defect is a PRODUCT fix, never a harness fix.** When an invariant fails or
   a persona reports something wrong, fix the engine/schema/web code. Do **not**
   edit the simulator to route around it, and do **not** relax an invariant.
2. **Never plug the books** to make a broken close/ledger look clean.
3. **The oracle is the judge.** `day-end` runs the invariant suite; if it halts,
   you stop and fix.

## Environment & safety

- The sim runs against the **`openbooks` database as its own tenant** — one tagged
  org (`SIM · …`) created inside it. It does **not** use or create a separate
  database. Sim orgs are isolated by org and destructive ops refuse any org that
  is not sim-tagged, so real tenants are safe.
- Every command needs `OPENBOOKS_SIM=1`. The DB URL comes from the repo `.env`
  (the shared cluster). Do not override it unless the user provides a dedicated
  sim DB.
- **Org-less engines are gated.** `run-recurring` and `run-dunning` scan *every*
  org, so they refuse to run unless the DB is a dedicated sim database. On the
  shared DB, skip them (or tell the user they need an isolated DB). All other ops
  are org-scoped and safe.

## How to run

### 1. Provision (once per run)

```bash
OPENBOOKS_SIM=1 npm --prefix engine run --silent sim -- provision \
  --profile general-contractor --seed 1 --start 2026-01-01 --end 2026-06-30
```

Profiles: `general-contractor`, `professional-services` (`list-profiles` for the
current set). `provision` prints a `runDir` — call it `<RUN>` and use it in every
command below. Pick a window that matches the user's ask (a quarter for a quick
proof; a year+ to exercise everything).

### 2. The daily loop

For each simulated day:

1. **Advance + inject events**
   ```bash
   OPENBOOKS_SIM=1 npm --prefix engine run --silent sim -- day-start <RUN>
   ```
   Advances the clock a day, injects the seeded events (bills arrive, work becomes
   billable, customer money lands), runs cheap integrity checks. If it prints
   `halted`, go to **Handling a halt**.

2. **Dispatch the team (spawn subagents).** Give each persona its playbook file,
   the `<RUN>`, and today's date. Sequence dependent work (AP posts before the
   controller closes); parallelize independent work (AP and AR the same day).
   - **AP Clerk** — `engine/src/sim/personas/ap-clerk.md` — every business day.
   - **AR Specialist** — `engine/src/sim/personas/ar-specialist.md` — every business day.
   - **Project Manager** — `engine/src/sim/personas/project-manager.md` — construction profile; monthly progress billing.
   - **Controller** — `engine/src/sim/personas/controller.md` — adjusting entries, write-offs, **month-end close**, period engines (depreciation, tax).
   - **CFO** — `engine/src/sim/personas/cfo.md` — weekly / month-end review.

   Each persona reads its screens (`observe …`) and acts (`act …`). If a persona
   reports a command error or a wrong number, treat it as a defect.

3. **Close out the day**
   ```bash
   OPENBOOKS_SIM=1 npm --prefix engine run --silent sim -- day-end <RUN>
   ```
   Cheap checks always; at a month boundary or after a close, the full golden
   suite + closed-period immutability probe. `pass: true` → next day. `halted` → stop.

You may batch several quiet days quickly and slow down around month-end, close,
and anything unusual. To fast-forward deterministically without personas (a
mechanical baseline for smoke/coverage), use `run <RUN>` instead of the loop.

## The persona commands (what each subagent uses)

Observe: `observe <screen> <RUN>` — `ap-inbox`, `ap-open`, `ar-inbox`,
`ar-receipts`, `ar-aging`, `trial-balance`, `period-status`, `projects`.

Act: `act <action> <RUN> --flags`:
- AP: `post-bill --doc`, `dispute-bill --doc --reason`, `pay-vendor --vendor --lines a,b`
- AR: `issue-invoice --doc`, `apply-receipt --payment --alloc lineId:amount,…`
- Controller: `post-journal --lines key:amount,…  --memo`, `close-month --period YYYY-MM`,
  `write-off --customer --amount --reason`, `void-doc --doc --reason`,
  `reverse-entry --entry`, `run-depreciation`, `prepare-tax --form --from --to`
- Construction: `setup-project --name --code --customer --lines "desc:value,desc:value"`,
  `progress-bill --project --fraction 0.1 --period YYYY-MM-DD`, `release-retainage --project --amount`

## Handling a halt

1. Read the defect bundle (`<RUN>/defects/<n>/`): `defect.json` + `repro.md`.
2. Reproduce & investigate against the org (`observe …` or query the DB). The seed
   guarantees the same failure.
3. **Fix the defect in the product** (engine/schema/web) — root cause.
4. Add a regression test in the relevant `*.test.ts`.
5. Confirm: `OPENBOOKS_SIM=1 npm --prefix engine run --silent sim -- verify <RUN>`
   (re-runs the oracle without advancing). `pass: true` clears the halt.
6. Continue the loop.

If the "defect" is actually correct accounting the *simulator* modeled wrong, fix
the simulator/profile and say so — the only case where harness code changes.

## Finishing

At `--end`, `day-start` returns `done: true`. Then:
```bash
OPENBOOKS_SIM=1 npm --prefix engine run --silent sim -- coverage <RUN>   # every expected capability fired
OPENBOOKS_SIM=1 npm --prefix engine run --silent sim -- status   <RUN>   # counters + defect log
```
Report to the user: months simulated, transaction counts, capabilities covered,
and every defect found + fixed. To wipe the run's org: `sim -- reset <RUN>`.
