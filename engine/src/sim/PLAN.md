# OpenBooks Business Simulation Harness — Plan

> A deterministic, resumable, calendar-driven simulator that runs realistic multi-team
> businesses across industries through the **real** OpenBooks engine — inserting bills,
> paying them, running projects, invoicing, reconciling banks, and closing months — while
> continuously proving accounting invariants. Every invariant break halts the run and
> becomes a defect the operator must fix before continuing.

Status: **PLAN** (nothing built yet). Target home: `@openbooks/sim` — a standalone,
public-release workspace package under `sim/`.

---

## 0. Goals & non-negotiables

**What it must do**

1. Simulate normal business activity **over time** for a variety of companies in different
   industries — general contractor, professional-services firm, product/distribution,
   subscription/SaaS, equipment/field-services, and a multi-entity group.
2. Exercise **every** capability through real code paths: AP bills, vendor payments,
   projects & job costing, AR invoices & customer receipts, AIA/retainage progress billing,
   field tickets, timesheets & labor costing, inventory, fixed assets & depreciation,
   recurring billing & dunning, bank feeds & reconciliation, tax returns, FX & consolidation,
   period close, and reporting.
3. **Play, pause, resume** deterministically — same seed reproduces the same business.
4. Instruct the operator to **stop and fix any product defect the moment it surfaces**, then
   deterministically replay to confirm the fix and continue.
5. Be **git-tracked and safe for public release** — no secrets, its own throwaway database,
   config-driven industry profiles the community can extend.

**Hard rules (baked into the harness and the operator runbook)**

- **The harness drives the product through its real functions.** It never writes journal
  rows directly to "make the books balance," never bypasses `postDocument`, never patches a
  product bug from inside the harness. A defect the simulation finds is a *product* fix.
- **Invariants are the oracle.** After every step and every period, the books must satisfy
  the accounting invariants (Section 6). A violation is a **halt**, not a warning.
- **Realism means full lifecycle, not just happy path.** A bill is received, approved, paid
  (early / on-time / late / disputed / partially / with a credit), reconciled, and closed —
  not merely posted.

---

## 1. Where this bolts onto the existing codebase

The engine is already headless-first and time-explicit, which makes this feasible without a
rewrite. Key anchors the harness reuses (verified during recon):

| Need | Existing anchor |
|---|---|
| Post any document | `engine/src/posting.ts` → `postDocument(docId, deps)`, `RULES[kind]` map |
| Create AP/AR payments + settle open items | `engine/src/payments.ts` → `createPaymentDocument`, `postPaymentWithApplications` |
| Batch AP pay runs | `engine/src/payment-operations.ts` |
| Create journals | `engine/src/journal-writes.ts` → `createScriptJournal` |
| Projects & charges | `web/lib/project-charges.ts` `createProjectCharge`, `engine/src/project-revenue.ts` |
| AIA / retainage billing | `engine/src/construction-billing.ts`, `schema/src/construction.ts` |
| Bank import / match / sign-off | `engine/src/banking.ts` → `importStatement`, `autoMatch`, `markReconciled` |
| Recurring / dunning / depreciation / FX (all take `asOf`) | `recurring.ts`, `dunning.ts`, `depreciation.ts`, `fx-revaluation.ts` |
| Period close & locks | `engine/src/close.ts` → `startCloseRun`, `setPeriodLockState` |
| Provision a full org spine | `engine/src/test-fixtures.ts` → `createScratchOrg`; `seed-*.ts`; `ensureCloseDefaults` |
| Reset / snapshot an org | `dropScratchOrg`; `engine/src/sandbox/` clone (deterministic UUID rebase, `as_of` trim) |
| Invariant checks + diffable checkpoint | `engine/src/harness/scenario.ts` → `runScenario` |
| Org-scoped DB execution | `engine/src/db.ts` → `withOrgContext(orgId, fn)`, `withBypass(fn)` |

**Two facts that shape the whole design:**

- **Accounting time is data, not a clock.** Posting resolves the period from
  `document.postingDate ?? documentDate` (`posting.ts`), and fiscal calendars/periods are
  first-class tenant rows (`schema/src/close.ts`, `schema/src/core.ts`). So advancing
  simulated time = stamping documents with the desired date and calling the `asOf`-aware
  engines. **No global clock refactor is required for the ledger itself.**
- **Identity & audit stamps are not deterministic.** PKs are `uuid_generate_v7()`
  (`schema/src/helpers.ts`), audit columns are `defaultNow()`, posting stamps
  `postedAt: new Date()`, and a few engines default `asOf` to `new Date()`. This is the one
  substrate we must tame for reproducibility (Section 3).

---

## 2. Determinism model — two tiers

Full byte-identical replay would require neutralizing every DB-minted UUID and `defaultNow()`.
That's expensive and unnecessary for the goal. We define two tiers:

- **Tier A — Financial determinism (required).** Same `(profile, seed)` ⇒ identical
  *business outcomes*: same trial balance, same subledger balances, same document
  counts/amounts/dates, same invariant results. Achieved with a seeded RNG + an injected
  simulated clock. Internal UUIDs may differ run-to-run; the checkpoint compares **values**
  (signed decimal strings), exactly as `scenario.ts` already does.
- **Tier B — Structural determinism (optional, advanced).** Byte-identical rows via the
  existing sandbox **deterministic UUID rebase** (`engine/src/sandbox/clone.ts` `ob_rebase`).
  Used only when we want to diff full row dumps or ship a frozen golden org. Not needed for
  the stop-and-fix loop.

The operator loop relies on **Tier A**. Reproducing a bug = re-running the same seed to the
same simulated date and replaying the offending activity.

---

## 3. Substrate work (Phase 0)

Small, bounded product changes that make simulation reproducible and observable.

1. **Injectable clock provider.** Add `engine/src/clock.ts`: an `AsyncLocalStorage`-backed
   `now(): Date` and `withSimClock(date, fn)`, mirroring the `orgContext` pattern already in
   `db.ts`. Default returns real `new Date()`; nothing changes in production. Then replace the
   handful of **business-meaningful** wall-clock reads to call `now()`:
   - `posting.ts` `postedAt` stamp,
   - the `asOf ?? new Date()` defaults in `dunning.ts`, `recurring.ts`, `depreciation.ts`,
     `fx-revaluation.ts`,
   - approval-gate timestamps in `flows/gates.ts` and close event stamps in `close.ts`.
   Audit `createdAt/updatedAt` may stay wall-clock (they're not part of the financial
   checkpoint). This is a *surgical* change, not a sweep.
2. **Seeded RNG.** `sim/src/rng.ts`: a splittable, serializable PRNG (e.g. SplitMix64 /
   PCG). Every stochastic choice (which vendor, how much, pay-on-time vs late) draws from a
   named sub-stream so adding a new activity type doesn't perturb existing streams. RNG state
   is part of the resumable run manifest.
3. **Run manifest format.** `sim/src/run-manifest.ts`: JSON written after every committed
   step — `{ runId, profile, seed, orgId, simDate, cursor, rngState, coverage, lastCheckpoint }`.
   This is the play/resume state.
4. **Sim data-source guard.** All simulator DB work runs under `withOrgContext(orgId, …)` so
   RLS is genuinely exercised; provisioning/reset runs under `withBypass`. The sim connects to
   its **own** database (never a real tenant DB) — enforced by a required `OPENBOOKS_SIM=1`
   env flag and a refusal to run against a URL lacking a `sim_`/`test_` marker.

---

## 4. The world: industry profiles & teams

A **profile** is pure config (JSON/TS) describing a company. The community can add profiles
without touching engine code — that's the "variety of industries" lever.

**Profile shape**

```
Profile {
  id, name, industry
  entities:        subsidiaries / books / currencies (multi-entity + FX for the group profile)
  chartOfAccounts: template or reuse of createScratchOrg's 15-account spine, extended per industry
  fiscalCalendar:  cadence (monthly | 4-4-5 | 13-period), year start, timezone
  projectTypes:    which BUILTIN_PROJECT_TYPES are enabled (T&M, fixed_price, cost_plus,
                   not_to_exceed, schedule_of_values)
  population:      vendors[], customers[], items[], employees[], equipment[]
                   each with behavior distributions (payment punctuality, dispute rate,
                   order size, seasonality)
  teams:           actors with IAM roles → AP clerk, AR clerk, controller, PM, foreman, CFO
  cadences:        per-activity frequency + seasonality (see Section 5)
  featureFlags:    settings.features to toggle (field tickets, dunning, consolidation, …)
}
```

**Launch profiles (map cleanly onto what the product already models):**

1. **General Contractor** — the deepest vertical. Projects with `schedule_of_values`,
   change orders, AIA G702/G703 pay applications, retainage withheld/released, field tickets,
   equipment charges, labor costing, overhead absorption (net-zero pair), progress-billed AR.
2. **Professional Services** — `time_and_materials` & `not_to_exceed` projects, timesheets →
   billable invoices, expense reports, recurring retainers.
3. **Product / Distribution** — inventory (FIFO / moving-avg / standard), POs → bills, sales
   orders → invoices → COGS, landed cost, cycle counts.
4. **Subscription / SaaS** — recurring billing schedules, deferred revenue recognition,
   dunning & collections, card charges.
5. **Equipment / Field Services** — equipment units costed to jobs, field tickets, mixed
   fixed-asset depreciation, high transaction volume.
6. **Multi-Entity Group** — 2–3 subsidiaries, intercompany journals (due-to/due-from),
   multicurrency + FX revaluation, consolidation & elimination, group close.

Each profile is provisioned by composing the existing seeders: `createScratchOrg` (or a
`withBypass` sequence of `orgs` insert → `ensureCloseDefaults` → `seedProjectTypes` →
`seedRoles` → `seedTaxForms` → `ensureReportDefinitions` → `seedAccountGroups`), then layering
the profile's population and teams.

---

## 5. The engine: calendar-driven discrete-event simulation

The core loop is a **simulated calendar**. Each tick is a business day; the scheduler emits
**activities** from the profile's cadences and stochastic processes.

**Activity abstraction**

```
Activity {
  name; kind;                       // e.g. "receive_bill", "run_pay_run", "close_period"
  eligible(ctx): boolean            // e.g. only on month-end, only if open bills exist
  plan(ctx): Intent[]               // draw amounts/parties from seeded RNG
  apply(ctx): Promise<Result>       // calls the REAL engine function(s)
  invariants: InvariantId[]         // which checks to run right after (cheap subset)
}
```

Activities call the real engine — never shortcuts:

| Activity | Real code path exercised |
|---|---|
| Receive bill / vendor credit | insert `documents` + `document_lines` → `postDocument` |
| Approve bill | `flows/` gates + `documents-adapter` `post_document` action |
| Pay vendors (single + batch) | `createPaymentDocument` + `postPaymentWithApplications`; `payment-operations` runs |
| Create project / log costs | project insert; `createProjectCharge`; field tickets (`field_ticket` kind) |
| Log time | `time_entries`; labor costing rate resolution |
| Bill customer (standard) | `documents` invoice + lines → `postDocument` |
| Bill customer (AIA) | `construction-billing.ts` pay-application → invoice kernel rule |
| Receive customer payment | `createPaymentDocument` (customer) + applications; partial/over/short |
| Recurring billing | `runDueRecurringSchedules(asOf)` |
| Dunning / collections | `runDunning(asOf)` |
| Card charges / expenses | `card_charge` / `expense_report` kinds → `postDocument` |
| Inventory movements | `inventory.ts` (receipts, issues, transfers, counts) |
| Depreciation | `runDepreciation(asOf)` |
| FX revaluation | `fx-revaluation.ts` at period-end rates |
| Bank statement + reconcile | generate statement → `importStatement` → `autoMatch` → `markReconciled` |
| Accruals / adjusting JEs | `createScriptJournal` |
| Period close | `startCloseRun` → tasks/signoff → `setPeriodLockState` per module → GL close |
| Tax returns | `tax-return.ts` / `tax-pool-run.ts` on the filing cadence |
| Consolidation | `consolidation.ts` at group month-end |

**Realism levers** (this is what makes it "100% realistic" rather than a smoke test):

- **Populations with behavior distributions** — vendors/customers with punctuality profiles
  (early / on-time / late / delinquent), dispute & short-pay rates, seasonal order volumes.
- **Full lifecycle & unhappy paths** — voids, vendor/customer credits, partial and
  over-payments, disputes, corrections/reclasses, backdated entries within an open period,
  period reopen requests, write-offs, bad debt.
- **Business rhythm** — daily inflow of bills/expenses/time; weekly timesheet approval & pay
  runs; invoice cadence per customer terms; month-end recurring/dunning/depreciation/
  FX/accruals/reconcile/close; quarterly tax; annual year-end + asset additions. Holidays &
  weekends respected.
- **Bank statements are generated from the ledger** (with realistic timing lag, fees,
  interest, and a few unmatched lines) so reconciliation is a genuine matching exercise, not
  a rubber stamp.

**The loop**

```
for each business day from start to --until:
    withSimClock(day):
        for each activity the scheduler emits (seeded order):
            plan → apply (real engine) → run cheap invariants
            if invariant fails: HALT → emit defect bundle
            update coverage; write run manifest (resumable checkpoint)
    if day is period-end:
        run FULL invariant suite (extended runScenario) + report cross-foot
        snapshot org (sandbox clone) as a rollback point
```

---

## 6. The oracle: invariants that turn bugs into halts

Extend `engine/src/harness/scenario.ts` and add the missing destructive companion
`engine/src/harness/close-scenario.ts` (referenced in scenario's header but never written).

**Continuous (cheap, after each activity):**

- Every posted entry nets to zero; global posted balance = 0.
- `documents.total` == journal debit-sum for the doc (known invariant).
- Applications never exceed a document's open balance; `open_balance` stays fresh.

**Per-period (full suite):**

- **Subledger ↔ GL tie-out** — AR, AP, retainage receivable, inventory, tax control accounts
  each reconcile to their subledger aging (worst residual < 0.01), extending scenario's
  existing AR/AP tie-out.
- **Overhead net-zero** — `origin='overhead_applied'` nets to zero per account (overhead
  never moves company P&L).
- **Report cross-foot** — Balance Sheet balances; P&L net income ties to retained-earnings
  movement; Cash Flow ties to the bank-balance delta; trial balance debits == credits.
- **Bank reconciliation** — signed-off recon difference is exactly 0.0000.
- **Immutability under close** (destructive `close-scenario.ts`, run on a sandbox clone):
  after GL close, attempts to post/edit into the closed period are **rejected**; reopen
  requires the approval flow.
- **Coverage assertion** — every enabled `document` kind, module, and report definition fired
  at least once by end of run ("prove all features out"); an untouched capability **fails**
  the run.

**On any failure → the defect bundle** written to `sim/runs/<runId>/defects/<n>/`:

```
defect.json     failing invariant, expected vs actual, residual, control account
repro.md        profile, seed, simDate, the exact activity + inputs that triggered it
manifest.json   the resumable run state at the point of failure
snapshot/       sandbox clone id of the org at failure (for inspection / re-run)
```

---

## 7. Play / pause / resume

- **State** = the run manifest (Section 3.3) + the committed DB org. Written after every step.
- **Resume** (`sim resume <runDir>`) reloads the manifest, restores RNG sub-stream state to
  the cursor, re-attaches to the existing org, and continues from the next activity. Because
  activities are already committed, resume is exact.
- **Rewind** (advanced, Tier B) uses period-end sandbox clones to roll back to a prior
  checkpoint and re-run forward — used to reproduce a bug before a fix and confirm after.
- **Reset** uses `dropScratchOrg(orgId)` (bypasses posted-entry immutability via the
  `openbooks.amend` / `sandbox_wipe` GUCs) or `resetSandbox` for a clean re-run.

---

## 8. The operator protocol (`sim/OPERATOR.md`)

The stop-and-fix loop is the point of the whole thing. The runbook the operator (human or an
AI agent) follows, verbatim:

1. **Run** `sim run --profile <p> --seed <s> --until <date>` (or `sim resume <runDir>`).
2. **On halt**, read the defect bundle. Reproduce with the printed one-line command; the seed
   guarantees the same failure.
3. **Fix the defect in the product** (engine/schema/web) — root cause, not the symptom.
   *Never* edit the harness to route around it; *never* relax an invariant to make it pass.
4. **Add a regression test** in the relevant `*.test.ts` capturing the exact case.
5. **Verify**: re-run the reproduction. The invariant now passes; the earlier steps still
   pass (deterministic replay).
6. **Continue** from the last good checkpoint. Repeat until the run reaches `--until` with
   full feature coverage and zero violations.

Escalation rule: if a "defect" is actually an intended accounting behavior the harness
modeled wrong, fix the **harness/profile** and note it — but that is the *only* case where the
harness changes, and it must be justified in the defect bundle.

---

## 9. Public-release packaging

- **Location**: new workspace package `sim/` → `@openbooks/sim`, added to the npm workspaces.
- **Layout**:
  ```
  sim/
    README.md            what it is, quickstart, how to add a profile
    OPERATOR.md          the stop-and-fix runbook (Section 8)
    PLAN.md              this document
    docker-compose.yml   throwaway Postgres for public users (no real data)
    src/
      clock.ts rng.ts run-manifest.ts        (substrate)
      world/               profile loader + provisioning
      profiles/            general-contractor.ts, prof-services.ts, distribution.ts,
                           subscription.ts, field-services.ts, multi-entity.ts
      activities/          one file per activity family
      scheduler.ts runner.ts
      invariants/          extends engine/src/harness
      cli.ts               run | resume | reset | list-profiles | coverage
    runs/                  .gitignored — manifests, checkpoints, defect bundles
  ```
- **Safety for public release**: no secrets or customer data; refuses to run without
  `OPENBOOKS_SIM=1` and a sim/test DB URL; profiles are synthetic; deterministic seeds so
  issues are reproducible by anyone.
- **CI**: a fast smoke job runs one profile for ~2 simulated months and asserts zero invariant
  violations + a minimum coverage threshold. A nightly job runs all profiles for ~2 simulated
  years and uploads any defect bundles as artifacts.

---

## 10. Delivery phases & milestones

| Phase | Deliverable | Proves |
|---|---|---|
| **0. Substrate** | `clock.ts` + surgical `now()` swaps, seeded RNG, run manifest, sim DB guard | Reproducibility + safe isolation |
| **1. World** | Profile loader + provisioning; **General Contractor** + **Professional Services** profiles with teams/populations | An org can be stood up from config |
| **2. Core activities** | AP receive/approve/pay, AR invoice/receive, JE, bank reconcile, month close | The everyday loop runs end to end |
| **3. Scheduler + resume** | Calendar loop, cadences, seasonality, manifest checkpoints, `run`/`resume` | Play/pause/resume over simulated time |
| **4. Oracle** | Extended `scenario.ts`, new `close-scenario.ts`, report cross-foot, coverage matrix, defect bundles | Bugs become halts with repros |
| **5. Operator + release** | `OPERATOR.md`, CLI, docker-compose, CI smoke, README | Public, git-tracked, stop-and-fix ready |
| **6. Breadth** | AIA/retainage, field tickets, inventory, depreciation, recurring/dunning, tax returns, FX/consolidation; remaining profiles | Every module exercised |
| **7. Adversarial** | Voids, credits, disputes, partial/over-pay, backdating, reopen, write-offs; volume stress | Invariants hold under messy reality |

**First runnable milestone** = end of Phase 4: the General Contractor profile runs a full
simulated quarter (bills → payments → projects → AIA invoices → receipts → reconcile → close),
the invariant suite gates each period, and the first real defect it finds halts the run with a
reproducible bundle. From there, breadth (Phase 6) and adversarial depth (Phase 7) expand
coverage until every capability is proven.

---

## 11. Open questions to settle before Phase 0

1. **Tier B needed at launch?** Byte-identical replay via sandbox rebase is powerful but
   optional; recommend deferring until a bug actually needs full-row diffing.
2. **Clock scope.** Confirm the minimal set of `new Date()` sites to route through `now()` —
   recommend: `postedAt`, the four `asOf` defaults, gate/close event stamps. Leave audit
   columns alone.
3. **Bank statement fidelity.** How much statement noise (fees, interest, timing lag,
   unmatched lines) before it stops being useful signal — start light, tune per profile.
4. **Volume targets.** Transactions/day per profile and how long a "2-year" run takes; sets
   the CI budget.

---

## 12. Architecture update — LLM team operates the environment (adopted)

The harness is **not** a pure deterministic script. Per direction, an LLM operates it *like
a team of humans*. Two decisions were locked:

- **Driver: Claude Code subagents.** The environment is the `npm run sim` CLI; each persona is
  a subagent Claude Code spawns, operating the business via `observe`/`act` commands over Bash.
- **Autonomy: hybrid.** A **seeded generator** injects each day's raw economic reality (bills
  arriving, work becoming billable, customer money landing); **LLM personas** make the judgment
  calls (approve/dispute/prioritize/apply-cash/close). Realism comes from their judgment; the
  environment stays deterministic and logged.

This splits the system into three layers:

1. **Environment (deterministic):** `world.ts` (provisioning), `generator.ts` (seeded daily
   events), `ops.ts` (the action surface — every capability routes through the real engine),
   `observe.ts` (read-only screens), `invariants/` (the oracle), `runner.ts` (day loop),
   `cli.ts` (the surface), `autopilot.ts` (a non-LLM persona stand-in for CI/dev).
2. **Team (LLM):** `personas/*.md` — AP clerk, AR specialist, controller, CFO. Each reads its
   screens and acts, and is instructed to surface anything that looks like a product defect.
3. **Operator (Claude Code):** `OPERATOR.md` — drives the daily loop, dispatches persona
   subagents, and on any invariant break or persona-reported bug **stops, fixes the product,
   and resumes**.

## 13. Implementation status

**Built and typechecking clean (`engine` `tsc --noEmit`, 0 errors):**

- Substrate: injectable `clock.ts`, seeded splittable `rng.ts`, resumable `manifest.ts`,
  sim-DB `db-guard.ts`.
- Profiles: `general-contractor`, `professional-services` (config-driven; add more freely).
- Environment: provisioning, seeded generator, ops (post/dispute/pay/issue/apply/journal/close),
  observation screens, the day loop with manifest checkpoints + resume, and the CLI.
- Oracle: cheap per-action checks + the full golden suite (`harness/scenario.ts`) + closed-
  period immutability probe + defect-bundle emitter that halts the run.
- Autopilot (deterministic CI/dev driver) + `run` convenience loop.
- Operator runbook, persona playbooks, README, throwaway `docker-compose.yml`, and a
  `sim-smoke` CI workflow.

**Phase 6 breadth — wired (typed engine functions; pending live validation):**

- Construction AIA/retainage: `ops-construction.ts` (`setupProject`, `runProgressBilling`,
  `releaseProjectRetainage`) + `observe projects` + PM persona + CLI `setup-project` /
  `progress-bill` / `release-retainage`. Retainage Receivable control account added.
- Period-driven engines: `ops-periodic.ts` wraps `runDepreciation`, `runDueRecurringSchedules`,
  `runDunning`, `computeTaxReturn`, `runRevaluation`, consolidation — as controller month-end ops.

**Phase 7 adversarial — wired:** `ops-lifecycle.ts` — `voidDocument` (document-delete),
`reverseEntry` (GL reversal), `writeOffReceivable` (bad-debt credit memo); CLI `void-doc` /
`reverse-entry` / `write-off`.

**LLM-callability:** `.claude/skills/run-simulation/SKILL.md` — told "run a simulation," an LLM
becomes the operator with the full loop, persona dispatch, and stop-and-fix protocol.

**Safety on the shared cluster:** the sim runs as its own **tagged tenant** inside the
`openbooks` DB (no separate DB; the role lacks CREATEDB). `db-guard.ts` gates: `OPENBOOKS_SIM=1`
required; destructive ops refuse non-`simHarness` orgs; org-less engines (`run-recurring`,
`run-dunning`) refuse unless the DB is a dedicated sim database.

**Deferred (additive):**

- The surgical `now()` swaps inside the engine hot path (`postedAt`, the `asOf` defaults). The
  clock is wired at the sim boundary (`withSimClock`); engine-side swaps left out to keep the
  posting path untouched. Not required for the financial checkpoint.
- Inventory activities, expense reports (needs an employee-party model), a multi-entity profile
  (to exercise FX/consolidation), field tickets.
- **Live validation:** not yet run. A first live attempt surfaced a real finding — `project_types`
  rejects INSERT under RLS bypass during provisioning; provisioning uses `withBypass`, so that
  RLS policy is a product defect to fix (not a harness workaround). Everything typechecks
  (`engine tsc --noEmit`: 0 errors) but has not executed against the DB.
