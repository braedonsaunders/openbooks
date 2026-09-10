# /payroll/runs/[id] ViewSpec integration handoff

Page: `web/app/(app)/payroll/runs/[id]/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the page needs no composite cells (see §4).
`RunWizard.tsx` and `BankFilePanel.tsx` are untouched; both render paths
share them through the proposed `pay-run-wizard` entry.

Spec widgets used: the `pageHeader` and `module-home-tabs` blocks (both
exist) plus `pay-run-wizard` (proposed below — does not exist in the
registry yet).

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (the component already exists in this page's directory):

```tsx
import { RunWizard } from '../../app/(app)/payroll/runs/[id]/RunWizard'
```

Entry (proposed location: directly after the `pay runs` block, next to
`new-pay-run` / `pay-run-row-actions`):

```tsx
/**
 * One pay run's processing wizard: five freely-navigable steps (scope →
 * readiness → review stubs → GL preview & commit → post & finish) whose
 * every control is an interactive fetch flow (calculate/commit/post,
 * dry-run, scope and adjustment mutations, GL preview, email stubs, bank
 * file download, record-payment) plus client state (active step, busy,
 * dialogs) a spec cannot name. Like `tax-page`, this entry binds loader
 * data to the shared `RunWizard` the native branch also renders — every
 * prop is one the native `<RunWizard …/>` already receives, in the same
 * order, including the loader-derived `initialStep` (`?step=` override or
 * the run/document-status derivation). The header shell (`pageHeader` with
 * back link + tabs) stays spec; the vitals strip, stale banner, step chips
 * and all five step bodies render inside the shared component, where the
 * conditional pairs (`when` cannot choose between two) already live.
 */
'pay-run-wizard': (props) => (
  <RunWizard
    run={props.run as ComponentProps<typeof RunWizard>['run']}
    stubs={(props.stubs as ComponentProps<typeof RunWizard>['stubs']) ?? []}
    roster={(props.roster as ComponentProps<typeof RunWizard>['roster']) ?? []}
    previousNet={
      (props.previousNet as ComponentProps<typeof RunWizard>['previousNet']) ?? {}
    }
    adjustments={
      (props.adjustments as ComponentProps<typeof RunWizard>['adjustments']) ?? []
    }
    adjustableComponents={
      (props.adjustableComponents as ComponentProps<typeof RunWizard>['adjustableComponents']) ?? []
    }
    remittance={(props.remittance as ComponentProps<typeof RunWizard>['remittance']) ?? []}
    bankAccounts={
      (props.bankAccounts as ComponentProps<typeof RunWizard>['bankAccounts']) ?? []
    }
    readiness={props.readiness as ComponentProps<typeof RunWizard>['readiness']}
    staleness={props.staleness as ComponentProps<typeof RunWizard>['staleness']}
    funding={props.funding as ComponentProps<typeof RunWizard>['funding']}
    changes={(props.changes as ComponentProps<typeof RunWizard>['changes']) ?? []}
    separationSections={
      (props.separationSections as ComponentProps<typeof RunWizard>['separationSections']) ?? []
    }
    registerReportId={(props.registerReportId as string | null) ?? null}
    canRun={props.canRun === true}
    initialStep={
      (props.initialStep as ComponentProps<typeof RunWizard>['initialStep']) ?? 'period'
    }
  />
),
```

No other entries: the header actions are the existing `module-home-tabs`
widget, and there is no drawer on this page.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

The sim tenant has three fixture runs but ZERO stubs, profiles, or
components (verified: `pay_stubs` → 0, `pay_components` → 0,
`employee_payroll_profiles` → 0), so the wizard is an empty shell without
the fixture rows in §3. After fixtures, the entry uses a FIXED run id
(detail-page precedent: the `/platform/users/<uuid>` entry), because
`?step=` is a client-state seed, not a server filter, and the engine
derivation already pins each run to its own opening step:

```js
{
  path: '/payroll/runs/00000000-0000-7000-9000-000000001811',
  // The pay-run wizard on a calculated run: the loader derives
  // initialStep 'review' (run_status calculated, document draft), so the
  // review stubs table with its two stub rows renders on load.
  variants: [
    {
      query: '',
      expect: 'main table tbody tr',
      minMatches: 2,
    },
    {
      query: '?step=readiness',
      expect: 'main ul li',
      minMatches: 1,
    },
  ],
  expect: 'main table tbody tr',
  minMatches: 2,
},
```

GATES verification (read-only queries against `openbooks_sim_viewspec`):

- `requirePermission('payroll.read')` + `can(authz, 'payroll.run')` — the
  harness user `viewspec@sim.test` holds the `Administrator` role
  (verified via `role_assignments`), whose permission set includes
  `payroll.read` and `payroll.run` (verified: full list read from
  `app_roles` for the harness org `da472d3a-…`).
- `requireFeatureEnabled(orgId, 'payroll')` — the harness org's
  `settings->'features'->'payroll'` is `true` (verified).
- Subsidiary scope — `allowedSubsidiaryIds` derives from the harness
  user's role; the fixture employee party (`Harborview Development LLC`,
  verified present in the harness org) carries whatever subsidiary the sim
  seed gave it, and the run/document/subject filters apply identically on
  both paths, so any scope restriction affects both renders equally.
- `?step=readiness` is NOT a filter variant in the `/compliance ?year=`
  sense: it cannot render identical markup to the default, because the
  loader pins run `…1811` to `review` (calculated/draft) while the query
  forces the client to open on `readiness` instead — the review stub table
  vs the readiness checklist are disjoint step bodies, so the two variants
  differ by construction. The `expect` selectors name elements each step
  always renders (stub rows on review; the readiness item list on
  readiness), not data-dependent counts.
- Post-fixture row counts: run `…1811` carries exactly 2 stubs (§3), each
  with 2 stub lines ⇒ `main table tbody tr` ≥ 2 on the default variant.
  The readiness variant's `main ul li` counts the readiness checklist
  items (blocker/warning rows the engine emits for the fixture run) — set
  `minMatches: 1`, not an exact count, to stay robust to engine-version
  drift in how many advisories a two-employee calculated run raises.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims a fresh **`…1901–1999` block** (verified free: no
`…000000000019xx` id anywhere in the fixtures file). Two stubs on the
existing fixture run `…1811` (PAY-00001, `calculated`/`draft`, period
2026-01-24–2026-02-06, pay date 2026-02-11, biweekly schedule `…1801`),
plus the minimum population rows the wizard's queries join against: two
`employee_payroll_profiles` rows (both on schedule `…1801`, so the Scope
roster lists them), two `labor_cost_rates` rows (so `has_wage` is true),
and the `BASE`/`BONUS` baseline components (so the adjustment picker and
the stub-line FKs resolve).

Why these rows and no more:

- The stubs query joins `parties` for the employee name; the roster query
  joins `parties`, `employee_roles`, `departments`, `trades`,
  `subsidiaries` (all LEFT except `parties`), `time_entries` (lateral,
  nullable → `coalesce(…, 0)`), `labor_cost_rates` (`exists` → boolean),
  and `pay_stubs` for the double-pay guard. Only `parties`,
  `employee_payroll_profiles`, and `labor_cost_rates` need fixture rows;
  everything else degrades to null/zero/false, which is itself a real
  branch (no department, no trade, no approved hours).
- `pay_stub_lines.component_id` is nullable with a LEFT join, so the lines
  deliberately carry one `BASE`-linked earning and one component-free
  deduction each — both join branches have data behind them.
- `previousNet` (variance baseline) needs a committed run with stubs for
  the same employees — the tenant has none, and seeding an entire second
  calculated-then-committed history just for a delta label is out of
  proportion. The review step renders without previous-net rows (its
  normal first-run state), and `payRunChanges` returns rows with null
  previous dates rather than failing. Said plainly: the ±15% variance flag
  has no fixture behind it; if the coordinator wants that branch pinned,
  the second run to back it is a follow-up, not part of this handoff.
- The remittance query reads `document_lines` with `having
  sum(dl.amount) < 0`, but the loader only passes remittance rows when
  `run_status = 'committed'` — run `…1811` is `calculated`, so remittance
  is `[]` on both paths regardless. No fixture rows needed (and none
  proposed): a variant that cannot differ from the default is not
  coverage.
- `separationSections` only loads for `run_type = 'termination'` — all
  three fixture runs are `regular`, so the ROE branch is empty on both
  paths. Not proposed as a variant for the same reason.
- `employee_count` on run `…1811` stays `1` while two stubs name two
  employees. The header renders the stored count verbatim on both paths
  (the loader does not recompute it), so this is a cosmetic fixture skew,
  not a divergence — noted here so nobody "fixes" it into a real diff.

```sql
  -- ---- pay-run wizard stubs --------------------------------------------------
  --
  -- The simulator never calculates payroll, so the /payroll/runs/[id] wizard
  -- renders an empty shell without these: two stubs on the existing fixture
  -- run …1811 (PAY-00001, calculated/draft) with their profiles, wage rates
  -- and baseline components. One stub is hourly-paid by EFT, the other is a
  -- salaried cheque payee — both payment rails and both pay bases behind one
  -- run. Each stub carries one BASE-linked earning and one component-free
  -- deduction, so both stub-line join branches render.
  declare
    v_emp_hourly uuid;
    v_emp_salary uuid;
    v_comp_base uuid := '00000000-0000-7000-9000-000000001901';
    v_comp_bonus uuid := '00000000-0000-7000-9000-000000001902';
  begin
    select id into v_emp_hourly from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    select id into v_emp_salary from parties
     where org_id = v_org and display_name = 'Ade Balogun (Apprentice)';
    if v_emp_hourly is null or v_emp_salary is null then
      raise notice 'missing fixture parties; skipping pay-run wizard fixtures';
      return;
    end if;

    -- Baseline earning components (the engine's own BASELINE_COMPONENTS
    -- codes: BASE/base_pay + BONUS/bonus — the adjustment picker only lists
    -- active components whose system_key is null or one of
    -- base_pay/overtime/bonus/vacation_payout).
    insert into pay_components
      (id, org_id, code, name, kind, system_key, country, basis, taxable,
       pensionable, insurable, vacationable, non_periodic, sequence, is_active)
    values
      (v_comp_base, v_org, 'BASE', 'Base pay', 'earning', 'base_pay', 'CA',
       'per_hour', true, true, true, true, false, 10, true),
      (v_comp_bonus, v_org, 'BONUS', 'Bonus', 'earning', 'bonus', 'CA',
       'fixed_amount', true, true, true, false, true, 30, true)
    on conflict (id) do nothing;

    -- Profiles on the biweekly fixture schedule (…1801): the Scope roster
    -- lists exactly these two employees.
    insert into employee_payroll_profiles
      (id, org_id, employee_party_id, pay_schedule_id, province, pay_basis,
       country, stub_delivery, payment_method, is_active)
    values
      (gen_random_uuid(), v_org, v_emp_hourly,
       '00000000-0000-7000-9000-000000001801', 'ON', 'hourly',
       'CA', 'email', 'eft', true),
      (gen_random_uuid(), v_org, v_emp_salary,
       '00000000-0000-7000-9000-000000001801', 'ON', 'salary',
       'CA', 'email', 'cheque', true)
    on conflict do nothing;

    -- Wage rates effective before the run's pay date (2026-02-11), so the
    -- roster's has_wage flag is true for both employees.
    insert into labor_cost_rates
      (id, org_id, employee_party_id, rate, basis, effective_from, is_active,
       currency)
    values
      (gen_random_uuid(), v_org, v_emp_hourly, 42.50, 'hour', date '2026-01-01',
       true, 'USD'),
      (gen_random_uuid(), v_org, v_emp_salary, 78000.00, 'year', date '2026-01-01',
       true, 'USD')
    on conflict (id) do nothing;

    -- Two calculated stubs on run …1811. country/filing columns satisfy the
    -- evidence CHECKs with the unknown-source branch (no pack is installed
    -- in the sim tenant, so no calculation evidence exists to cite).
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
       currency_code, gross, pensionable_earnings, insurable_earnings,
       net_pay, employer_cost, vacation_accrued, factors,
       country_source, filing_account_source)
    values
      ('00000000-0000-7000-9000-000000001911', v_org,
       '00000000-0000-7000-9000-000000001811', v_emp_hourly, 'ON',
       26, date '2026-02-11', 2026, 0, 0,
       'USD', 3400.00, 3400.00, 3400.00,
       2510.75, 3620.40, 136.00, '{"T": "441.20", "C": "186.85", "EI": "61.20"}',
       'unknown', 'unknown'),
      ('00000000-0000-7000-9000-000000001912', v_org,
       '00000000-0000-7000-9000-000000001811', v_emp_salary, 'ON',
       26, date '2026-02-11', 2026, 0, 0,
       'USD', 3000.00, 3000.00, 3000.00,
       2248.10, 3180.00, 120.00, '{"T": "380.55", "C": "164.80", "EI": "53.90"}',
       'unknown', 'unknown')
    on conflict (id) do nothing;

    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, hours, rate,
       amount, sequence)
    values
      ('00000000-0000-7000-9000-000000001921', v_org,
       '00000000-0000-7000-9000-000000001911', v_comp_base, 'earning',
       'Regular hours', 80, 42.50, 3400.00, 1),
      ('00000000-0000-7000-9000-000000001922', v_org,
       '00000000-0000-7000-9000-000000001911', null, 'deduction',
       'Income tax', null, null, -441.20, 2),
      ('00000000-0000-7000-9000-000000001923', v_org,
       '00000000-0000-7000-9000-000000001912', v_comp_base, 'earning',
       'Salary', null, null, 3000.00, 1),
      ('00000000-0000-7000-9000-000000001924', v_org,
       '00000000-0000-7000-9000-000000001912', null, 'deduction',
       'Income tax', null, null, -380.55, 2)
    on conflict (id) do nothing;
  end;
```

Caveats for the coordinator (verified as far as read-only queries allow):

- Conflict targets: `pay_components_pkey`, `pay_stubs_pkey` and
  `pay_stub_lines_pkey` are on `id` (same convention as the confirmed
  `documents_pkey` / `document_lines_pkey`), so those three
  `on conflict (id)` clauses are exact. For `employee_payroll_profiles`
  and `labor_cost_rates` I could NOT confirm a usable unique constraint
  (both use `gen_random_uuid()` per row, so a retry-safe `on conflict
  (id)` would never fire anyway) — they use a bare
  `on conflict do nothing`, which requires SOME unique constraint to be
  valid syntax; if either table has none, or no `id` PK, both inserts must
  become `where not exists` guards instead. Worth one `\d
  employee_payroll_profiles` / `\d labor_cost_rates` before folding in.
- `pay_stubs` NOT NULL columns beyond the insert list: `created_at` /
  `updated_at` (verified NOT NULL without visible defaults in the
  information_schema probe — if they lack defaults the insert fails and
  needs `now(), now()` added). `country_source` / `filing_account_source`
  are verified NOT NULL with no defaults; `country` (nullable) +
  `country_source = 'unknown'` satisfies `pay_stubs_country_evidence`,
  and `filing_account_source = 'unknown'` with null id/evidence satisfies
  `pay_stubs_filing_account_evidence`. `payment_method` is left null
  (allowed). `pay_stubs_net_nonnegative` — both `net_pay` values are
  positive ✓.
- The stub `factors` JSON (`T`/`C`/`EI`) feeds the review step's statutory
  CPP/EI/tax columns via the wizard's `statutory()` helper — plain data,
  no constraint behind it.
- `employee_payroll_profiles` CHECKs: `pay_basis` ∈ hourly/salary ✓,
  `country` ∈ CA/US ✓, `payment_method` ∈ eft/cheque ✓. `province` is
  NOT NULL with no verified CHECK name matched (only `prov_code`
  shown) — `'ON'` is the value the payroll engine itself seeds, so it is
  safe under any Ontario-shaped constraint.
- `labor_cost_rates` CHECKs: `basis` ∈ hour/year ✓, `rate >= 0` ✓,
  `num_nonnulls(employee_party_id, job_title, trade_id, department_id,
  subsidiary_id) <= 1` — exactly one set (the employee) ✓.
  `annual_hours` nullable (no NOT NULL seen) — left null. `currency` is
  NOT NULL with no default — `'USD'` matches the harness org's
  `base_currency` (verified).
- `pay_components` unique `(org_id, code)` (verified from the engine's
  own `on conflict (org_id, code)`) — `BASE`/`BONUS` are the engine's
  canonical baseline codes; if the sim tenant ever installs a payroll
  pack, these rows already exist and the `on conflict (id)` keeps them.
  `tax_treatment`, `expense_account_id`, `protection_*` and the cap
  columns are all nullable (no NOT NULL seen) — left null.
- The `payroll` feature flag resolves on for the SIM org (verified
  `settings->'features'->'payroll' = true`), or the page 404s in both
  branches.
- `report_definitions` needs NO fixture row: the loader takes
  `registerReport?.id ?? null`, and the wizard renders its register link
  only when non-null — null on both paths is identical markup.

## 4. What the spec does NOT cover (deliberate, documented)

- No `sections.tsx`: the page defines no local components. `RunWizard`
  (with `BankFilePanel`, the five step bodies, and the vitals/strip/chips
  chrome) lives in this directory but is a client component with fetch
  flows — the brief's tax precedent keeps such components shared, not
  moved, so the entry references it directly.
- The header `back` link (`/payroll/runs` + `t('list.title')`) and the
  `description`'s leading-`' · '` strip (`.replace(/^ · /, '')`) are
  loader-computed (`backHref`/`backLabel`/`description`), matching the
  native template literal exactly.
- The `payroll` feature gate, the uuid 404, the run 404, and the
  population-lock 404 (`PayrollError` → `notFound()`) all run in the
  LOADER inside the same `db.transaction` — both branches 404 identically.
  Nothing travels through the spec for any of them.
- `canRun` (`payroll.run`) is a loader-derived boolean. The wizard's
  internal gates (`canCalculate`/`canCommit`/`canPost`/`canEditScope`/
  `canAdjust`) re-derive inside the shared component from `canRun` +
  run/document status + readiness/staleness — byte-identical on both
  paths because it is the same component.
- Readiness, staleness, funding and changes are engine-owned values that
  travel as opaque data. The funding `bankAccounts` picker reuses the
  funding service's scoped rows (the anti-escalation rule) in the loader,
  exactly as the native page does.
- The `?step=` param is a client-state seed, not a server filter: the
  loader derives `initialStep` from it (validated against `STEPS`, with
  the run/document-status fallback), and the shared component owns the
  `useState(initialStep)` afterwards. `?step=readiness` is proposed as the
  second variant because it opens a disjoint step body (readiness
  checklist vs review stub table) — the two renders differ by
  construction, which is what the identical-markup guard requires. No
  `?step=` value is proposed for filtering rows, because none filters
  anything.
