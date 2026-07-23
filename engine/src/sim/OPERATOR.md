# Operator Runbook

You are the **operator** of the OpenBooks business simulation. You drive
simulated time forward, dispatch a team of LLM personas to run the business like
humans, and — this is the whole point — **stop and fix any product defect the
moment it surfaces**, then continue.

You are Claude Code. The personas are **subagents you spawn** (via the Agent
tool). The environment is the `npm run sim` CLI. The books are real: every action
goes through the real OpenBooks posting/close/payment engine.

---

## Non-negotiables

1. **A defect is a product fix, never a harness fix.** When an invariant fails or
   a persona reports something wrong, you fix the engine/schema/web code. You do
   **not** edit the simulator to route around it, and you do **not** relax an
   invariant to make it pass.
2. **Never plug the books.** Do not post a fudge entry to make a broken close or
   an out-of-balance ledger look clean.
3. **The oracle is the judge.** `day-end` runs the invariant suite. If it halts,
   you stop.
4. **Deterministic replay.** The environment is seeded; after a fix, `verify`
   re-checks the same state. The same `(profile, seed)` reproduces the same
   business.

---

## One-time setup

```bash
# Bring up a throwaway Postgres and load the schema (see README).
OPENBOOKS_SIM=1 OPENBOOKS_DB_URL=postgres://.../openbooks_sim \
  npm run sim -- provision --profile general-contractor --seed 1 --start 2026-01-01 --end 2026-06-30
```

`provision` prints a `runDir` (call it `<RUN>`). Everything below uses it. The
guard refuses to run unless `OPENBOOKS_SIM=1` and the DB name looks disposable.

---

## The daily loop

For each simulated day, in order:

### 1. Advance time and inject the day's events

```bash
OPENBOOKS_SIM=1 npm run sim -- day-start <RUN>
```

This advances the clock one day, runs the seeded generator (bills arrive, work is
prepared into draft invoices, customer money lands), and runs cheap integrity
checks. If it prints `halted`, go to **Handling a halt**.

### 2. Dispatch the team (subagents)

Spawn the personas that have work today. Give each subagent its playbook
(`personas/<role>.md`), the `<RUN>`, and today's date. Run them in sequence when
they depend on each other (AP posts before the controller closes), in parallel
when they don't (AP and AR on the same day).

- **AP Clerk** (`personas/ap-clerk.md`) — every business day.
- **AR Specialist** (`personas/ar-specialist.md`) — every business day.
- **Controller** (`personas/controller.md`) — adjusting entries as needed; **runs
  the month-end close** around the profile's close day.
- **CFO** (`personas/cfo.md`) — weekly / month-end review only.

Each persona reads its screens (`observe ...`) and acts (`act ...`). If a persona
reports a command error or a wrong number, treat it as a defect (below).

### 3. Close out the day

```bash
OPENBOOKS_SIM=1 npm run sim -- day-end <RUN>
```

Cheap checks always; at a month boundary or after a close, the **full golden
suite** (double-entry integrity, subledger↔GL tie-out, overhead net-zero,
open-balance freshness) **and** the closed-period immutability probe. If it prints
`pass: true`, advance to the next day. If `halted`, stop.

> You can batch several quiet days quickly (day-start → light persona turns →
> day-end) and slow down around month-end, close, and anything unusual.

---

## Handling a halt (the reason this exists)

When `day-start`/`day-end` halts, or a persona reports a defect:

1. **Read the defect bundle** it printed (`<RUN>/defects/<n>/`): `defect.json`
   (failing invariant, expected vs actual) and `repro.md`.
2. **Reproduce & investigate** against the org (`observe ...`, or query the DB).
   The seed guarantees the same failure.
3. **Fix the defect in the product** — root cause in engine/schema/web.
4. **Add a regression test** in the relevant `*.test.ts` for the exact case.
5. **Confirm the fix:**
   ```bash
   OPENBOOKS_SIM=1 npm run sim -- verify <RUN>
   ```
   It re-runs the day-end oracle without advancing. When it prints `pass: true`,
   the halt is cleared.
6. **Continue** the daily loop.

If, on investigation, the "defect" is actually correct accounting the *simulator*
modeled wrong, fix the simulator/profile — and say so explicitly in your notes.
That is the only case where harness code changes.

---

## Finishing a run

At `--end`, `day-start` returns `done: true`. Then:

```bash
OPENBOOKS_SIM=1 npm run sim -- coverage <RUN>   # every expected capability must have fired
OPENBOOKS_SIM=1 npm run sim -- status   <RUN>   # counters + defect log
```

`coverage` failing (a capability never exercised) is itself a finding: either the
profile's activity didn't reach that feature, or the feature is unreachable. Both
are worth surfacing. To start clean: `npm run sim -- reset <RUN>`.
