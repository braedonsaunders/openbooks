# /payroll/opening-balances ViewSpec integration handoff

Page: `web/app/(app)/payroll/opening-balances/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.
No `sections.tsx`: nothing is moved or duplicated — `OpeningBalancesView`
and `EntitlementOpeningsView` stay where they are and both render paths
import the same components.

Spec blocks used: `pageHeader` (exists) + `module-home-tabs` (exists in
the registry) + one `grid('space-y-8')` (exists — the native
`<div className="space-y-8">` wrapper) + `opening-balances-grid` and
`entitlement-openings-grid` (proposed below — neither exists yet).

## Why two whole widgets

This page is two fully client-interactive grids, not server-rendered
lists. Everything below lives in component state or bound fetch calls,
and none of it is spec vocabulary:

- the year-grid's statutory draft + component draft (two separate maps —
  two key spaces), the banks grid's plan drafts plus the adoption-date
  input, all `useState`, none URL-addressable;
- the two save POSTs (`/api/payroll/opening-balances` with `taxYear`,
  `/api/payroll/opening-balances/entitlements` with `movementDate`) with
  toast feedback and `router.refresh()`;
- the error/warning callouts, the only-missing toggle, the legacy-prefill
  action (writes into draft state), the year-picker `router.push`.

The tables cannot be decomposed into `table` blocks either: their cells
are conditional pairs (locked badge vs "none" marker, per-pack input vs
em-dash, per-plan lock badge + input, blocked hint paragraph, legacy
marker) plus multi-element cells (employee cell wraps name + number +
badges; plan header wraps name + FieldHelp; component header wraps name +
cap-dependent help text). A spec cannot express any of that, and
splitting the tables out would put one component's state in two places.
This is the same call the retro/parallel-run/year-end pages made: the
workspaces stay whole.

Money, dates and counts are deliberately NOT formatted in the loader.
The native components format client-side (`trimZeros` display over raw
store strings; drafts are raw input text). Per the trap list, the loader
passes the canonical engine values through and the components do what
they always did. Formatting them server-side would double-format and
change the bytes.

The permission gates ARE load-bearing and are reproduced verbatim:
`payroll.read` via `requirePermission`, the `payroll` feature gate (404
when disabled), the `payroll.manage` flag for both Save actions, and the
module tabs via `groupTabs` (which filters on the org's feature state).
Both row populations are visibility-filtered —
`scopedOpeningBalances` / `scopedEntitlementOpenings` apply
`visiblePayrollEmployeeIds(gate)` to rows, entered counts, the years
list and the blocked map (counts are disclosures, not just filters) —
and the loader reproduces them by calling the same functions. The
`Authz`/org id never cross the spec boundary — the loader consumes
them, the widgets receive only rows + booleans.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed (components already exist in my owned dir):

```tsx
import { EntitlementOpeningsView } from '../../app/(app)/payroll/opening-balances/EntitlementOpeningsView'
import { OpeningBalancesView } from '../../app/(app)/payroll/opening-balances/OpeningBalancesView'
```

Entries (place in the payroll group, beside `retro-workspace` /
`parallel-run-workspace` / `year-end-workspace`):

```tsx
/**
 * Mid-year adoption grid. Placed whole rather than decomposed: it owns
 * statutory + component draft state, the year-picker/only-missing client
 * state, the save POST with toast feedback, the error callout and every
 * conditional pair (locked badge vs none marker, per-pack input vs
 * em-dash). Money stays canonical text: the component formats client-side
 * (trimZeros display over raw store strings).
 */
'opening-balances-grid': (props) => (
  <OpeningBalancesView
    year={num(props, 'year') ?? new Date().getFullYear()}
    currentYear={num(props, 'currentYear') ?? new Date().getFullYear()}
    initial={props.initial as ComponentProps<typeof OpeningBalancesView>['initial']}
    fields={props.fields as ComponentProps<typeof OpeningBalancesView>['fields']}
    components={props.components as ComponentProps<typeof OpeningBalancesView>['components']}
    canManage={props.canManage === true}
  />
),
/**
 * Bank carry-ins grid. Same whole-widget reasoning: plan drafts, the
 * adoption-date input, the save POST, the legacy banner + prefill action,
 * error/warning callouts and the per-plan lock pairs. Year-agnostic by
 * design — a bank has one lifetime balance, so this widget takes no year.
 */
'entitlement-openings-grid': (props) => (
  <EntitlementOpeningsView
    initial={props.initial as ComponentProps<typeof EntitlementOpeningsView>['initial']}
    canManage={props.canManage === true}
  />
),
```

**Exact prop shapes the spec passes** (flat props, matching each
component's destructured signature — the coordinator wires them
verbatim):

| widget | prop | type | source |
|---|---|---|---|
| `opening-balances-grid` | `year` | `number` | clamped `?year=` override over `businessToday` year (2000–2100 else business year), exactly as page.tsx |
| | `currentYear` | `number` | business year from `businessToday(orgId)` |
| | `initial` | `OpeningBalanceYear` (`{ taxYear, rows: OpeningBalanceRow[], entered, years: number[], components: OpeningComponentField[] }`) | `scopedOpeningBalances(authz, year)` verbatim (subsidiary-visibility-filtered rows, entered count and years list) |
| | `fields` | `{ key: string; label: string; help: string; packs: string[] }[]` (9 entries, entry order) | `OPENING_BALANCE_FIELDS` mapped verbatim, exactly as page.tsx |
| | `components` | `OpeningComponentField[]` (`{ componentId, code, name, kind, basisCapAmountPerYear: string \| null, capped: boolean }[]`) | `data.components` verbatim (same ref page.tsx passes) |
| | `canManage` | `boolean` | `can(authz, 'payroll.manage')` |
| `entitlement-openings-grid` | `initial` | `EntitlementOpeningsResult` (`{ plans: EntitlementPlan[], rows: EntitlementOpeningRow[], entered, asOf: string, blocked: Record<string, EntitlementOpeningLock> }`) | `scopedEntitlementOpenings(authz)` verbatim — deliberately year-agnostic |
| | `canManage` | `boolean` | `can(authz, 'payroll.manage')` |

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/payroll/opening-balances',
  // Two whole-workspace widgets: the statutory adoption grid and the bank
  // carry-ins grid. The fixture block below seeds two 2026 statutory
  // carry-ins (one with a capped-component opening), one 2025 legacy
  // vacation carry-in, two entitlement plans and one bank opening — so the
  // default render carries 3 + 3 body rows plus the locked badges and the
  // legacy banner. ?year=2025 pins the year-override path (legacy-year
  // grid, unlocked inputs, banks section unchanged — still 6 rows).
  variants: [
    '',
    { query: '?year=2026', expect: 'main table tbody tr', minMatches: 6 },
    { query: '?year=2025', expect: 'main table tbody tr', minMatches: 6 },
  ],
  expect: 'main table tbody tr',
  minMatches: 6,
},
```

Verified against `openbooks_sim_viewspec` (RLS bypassed; harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` = `SIM · Summit Ridge Construction`):

- `payroll` feature on for the harness org
  (`settings->'features'->'payroll'` → `true`) — the feature gate passes.
- Active payroll population (active profile + active party): **3**
  employees (`Harborview Development LLC`, `Ade Balogun (Apprentice)`,
  `Chloe Martin (Apprentice)`). `openingBalancesForYear` returns the
  whole population with `amounts: null` where no row exists, so the year
  grid renders 3 body rows with or without fixtures; `entitlementOpenings`
  likewise returns all 3 rows.
- `payroll_opening_balances`: **0 rows**; `entitlement_plans`: **0
  rows** — without fixtures the banks section renders its no-plans
  branch (no table) and the year grid renders blank unlocked inputs, so
  the fixture below is required (the harness refuses to compare
  empty-vs-empty).
- After fixtures: year grid 3 rows + banks grid 3 rows = **6**
  `main table tbody tr`. Both grids render raw `<table>`/`<tbody>`
  (not the UI `Table` primitives), and both are non-empty, so the
  selector matches both. The legacy banner, the locked badges and the
  component column all render from the same fixture rows (see §3).
- `?year=2025`: the population is NOT year-scoped, so still 3 year-grid
  rows (Chloe entered with all-zero statutory amounts, no 2025 locks —
  locks test `tax_year = 2025` stubs, of which there are none) plus the
  unchanged 3-row banks grid = 6 rows.
- `blocked` is empty on the default render: `asOf` = business-today
  (2026-09-10) while the committed stubs pay 2026-03-11
  (`pay_date >= asOf` matches nothing) — no blocked hints either way.
- Gates: same as the already-green `/payroll/retro`,
  `/payroll/parallel-run` and `/payroll/year-end` entries (harness user
  `viewspec@sim.test` holds the `admin` role per the `/payroll`
  INTEGRATION.md precedent, whose permission set covers `payroll.read`
  + `payroll.manage`; feature flag verified `true` above). Either way
  both renders share the loader, so a gate answer is identical — but
  both pass.
- Visibility filtering: both scoped loaders apply
  `visiblePayrollEmployeeIds(gate)`. The harness user is unrestricted,
  so the full 3-row population renders — the loader calls the same
  functions, exactly as page.tsx does.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims the fresh id block `…1870–1879` (zero hits for `0000000018[6-9]x`
across `scripts/viewspec-fixtures.sql`, all `INTEGRATION.md` files and
`scripts/viewspec-conformance.mjs`; only `…1860` exists nearby, as live
sim data with no fixture owner). Live parties resolve by display name;
nothing here touches a real tenant (SIM org only, `ON CONFLICT (id)
DO NOTHING` throughout, fixed ids).

What it seeds and why each row matters to the render:

- `…1870` / `…1871`: 2026 statutory carry-ins for Harborview and Ade
  (non-zero CPP/EI/tax amounts → stored-value inputs via the
  `trimZeros` branch). All three employees hold committed 2026 stubs
  on run `…1813` (Harborview `…1842`, Ade `…1850`, Chloe the live sim
  stub `…1860`), so all three 2026 rows render the Locked badge — the
  lock path — including Chloe's blank row.
- `…1872`: a 2025 row for Chloe carrying ONLY `vacation_balance = 80`
  (all statutory columns zero). The deprecated column with no matching
  vacation opening → `legacyVacationBalance` surfaces: the amber
  "Unmigrated vacation balances" banner (`legacyCount = 1`) plus the
  legacy marker on her banks row. Also puts 2025 in the year picker.
- `…1873` / `…1874`: two entitlement plans — `VAC` (Vacation,
  `system_key = 'vacation'`, `unit = 'hours'`) and `BANK` (Banked time,
  `unit = 'hours'`), both `manual` method. Without these the banks
  section renders no-plans; with them it renders the 3-row grid.
- `…1875`: `VS-401K` earning component with
  `basis_cap_amount_per_year = 23000` — the only capped component in the
  sim org, so the year grid renders its component column (every other
  sim component is uncapped and contributes none).
- `…1876`: Harborview's component opening (`…1870` × `…1875`, 5000) →
  stored component value in a locked row.
- `…1877`: Harborview's vacation bank opening (40 hours, movement
  date 2026-01-05, before every committed stub) → stored bank value and
  entered count 1. Harborview's stub `…1842` pays 2026-03-11 (after the
  movement date), so this opening IS lock-covered at the plan level —
  the per-plan lock badge on her Vacation cell. (The row-level
  `blocked` map stays empty: `asOf` is business-today, after all
  stubs.)

```sql
  -- ---- opening balances ----------------------------------------------------
  --
  -- The simulator never adopts mid-year, so /payroll/opening-balances
  -- compares two identical empty states without these: no statutory
  -- carry-ins (0 rows), no entitlement plans (the banks section renders
  -- its no-plans branch — no table at all), and no capped components
  -- (no component column). Block …1870–1879. Live parties resolve by
  -- display name; other ids are fixed. Guard-before-insert throughout:
  -- the UNIQUEs here are all bare `ON CONFLICT (id)`-compatible
  -- (payroll_opening_balances_employee_year,
  -- entitlement_ledger_opening, entitlement_plans_org_code,
  -- entitlement_plans_org_system) — EXCEPT the re-run shape of the
  -- ledger guard: see the WARNING below.
  declare
    v_harbor uuid;
    v_ade uuid;
    v_chloe uuid;
    v_ok boolean;
  begin
    select id into v_harbor from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    select id into v_ade from parties
     where org_id = v_org and display_name = 'Ade Balogun (Apprentice)';
    select id into v_chloe from parties
     where org_id = v_org and display_name = 'Chloe Martin (Apprentice)';
    -- Two committed 2026 stubs already exist on run …1813 for Harborview
    -- (…1842, remittance fixture) and Ade (…1850, year-end fixture); the
    -- third employee (Chloe) carries the live sim stub …1860 on the same
    -- run. All three lock their 2026 rows, which is the point.
    -- NOT `return`: a bare return in a nested block exits the WHOLE
    -- anonymous block, silently skipping every fixture below this one.
    v_ok := v_harbor is not null and v_ade is not null and v_chloe is not null
      and exists (
        select 1 from pay_runs
         where org_id = v_org
           and document_id = '00000000-0000-7000-9000-000000001813'
           and run_status = 'committed');
    if not v_ok then
      raise notice 'missing fixture parties or committed run; skipping opening-balances fixtures';
    else

    -- Two entitlement plans. MANUAL method needs no accrual_value (the
    -- accrual_value CHECK only fires for non-manual methods). `VAC`
    -- carries system_key 'vacation' — the legacy-banner join key — and
    -- there is exactly one such plan org-wide (org_system UNIQUE).
    insert into entitlement_plans
      (id, org_id, code, name, system_key, unit, direction, accrual_method,
       cap_behavior, is_active)
    values
      ('00000000-0000-7000-9000-000000001873', v_org, 'VAC',
       'Vacation', 'vacation', 'hours', 'accrue', 'manual', 'warn', true),
      ('00000000-0000-7000-9000-000000001874', v_org, 'BANK',
       'Banked time', null, 'hours', 'accrue', 'manual', 'warn', true)
    on conflict (id) do nothing;

    -- One capped component. NULL system_key (no pack declaration can
    -- reroute it), kind + basis satisfy their CHECKs, the annual cap is
    -- non-negative. The sim's own BASE/BONUS/VS-TAX/VS-CPP components
    -- are all uncapped, so this is the only component column.
    insert into pay_components
      (id, org_id, code, name, kind, system_key, country, basis, taxable,
       pensionable, insurable, vacationable, non_periodic, sequence,
       is_active, basis_cap_amount_per_year)
    values
      ('00000000-0000-7000-9000-000000001875', v_org, 'VS-401K',
       'ViewSpec 401(k)', 'deduction', null, 'CA', 'fixed_amount',
       true, false, false, false, false, 102, true, 23000.0000)
    on conflict (id) do nothing;

    -- Two 2026 statutory carry-ins + one 2025 legacy-only row. The
    -- (org, employee, year) UNIQUE owns re-run idempotence alongside
    -- ON CONFLICT (id). Chloe's 2025 row carries ONLY vacation_balance:
    -- every statutory column is 0 (the trimZeros blank branch) and the
    -- unmigrated legacy banner fires (no VAC opening exists for her).
    insert into payroll_opening_balances
      (id, org_id, employee_party_id, tax_year,
       pensionable_ytd, insurable_ytd, cpp_ytd, cpp2_ytd, ei_ytd, qpip_ytd,
       taxable_ytd, tax_ytd, non_periodic_ytd, vacation_balance)
    values
      ('00000000-0000-7000-9000-000000001870', v_org, v_harbor, 2026,
       45000.0000, 42000.0000, 2380.5000, 0.0000, 1045.2500, 0.0000,
       46000.0000, 6200.0000, 5000.0000, 0.0000),
      ('00000000-0000-7000-9000-000000001871', v_org, v_ade, 2026,
       30000.0000, 30000.0000, 1580.0000, 0.0000, 750.0000, 0.0000,
       31000.0000, 4100.0000, 0.0000, 0.0000),
      ('00000000-0000-7000-9000-000000001872', v_org, v_chloe, 2025,
       0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000,
       0.0000, 0.0000, 0.0000, 80.0000)
    on conflict (id) do nothing;

    -- Harborview's component opening: the (opening_balance_id,
    -- component_id) UNIQUE owns re-run safety; the non-negative CHECK
    -- passes (5000 > 0).
    insert into payroll_opening_balance_components
      (id, org_id, opening_balance_id, component_id, ytd_amount)
    values
      ('00000000-0000-7000-9000-000000001876', v_org,
       '00000000-0000-7000-9000-000000001870',
       '00000000-0000-7000-9000-000000001875', 5000.0000)
    on conflict (id) do nothing;

    -- Harborview's vacation bank opening. The (org, plan, employee)
    -- partial-unique (kind = 'opening') owns re-run safety; kind 'opening'
    -- has no sign CHECK; the append-only trigger guards UPDATE/DELETE,
    -- not INSERT, so re-applying the identical row is a silent skip.
    insert into entitlement_ledger
      (id, org_id, plan_id, employee_party_id, movement_date, amount,
       hours, kind, note)
    values
      ('00000000-0000-7000-9000-000000001877', v_org,
       '00000000-0000-7000-9000-000000001873', v_harbor,
       date '2026-01-05', 40.0000, 40.0000, 'opening',
       'ViewSpec fixture: vacation carry-in')
    on conflict (id) do nothing;

    end if;
  end;
```

WARNING — validate-then-rollback residue: validating this SQL by hand
against `openbooks_sim_viewspec` permanently wrote the `…1877`
`entitlement_ledger` opening row (Harborview's committed `…1842` stub
consumes it, so the append-only guard refuses its delete). The `…1873
VAC` plan it references is likewise undeletable (FK). To return the DB
to its prior state the validator deleted every other row (`…1870–1872`,
`…1874–1876`); `…1873` + `…1877` remain. Coordinator: applying the
fixture block reuses those two ids via `ON CONFLICT (id) DO NOTHING`
(correct — same content), but note the residue. The also affected
`/admin/setup/payroll` conformance entry claims `entitlement_plans`
is empty — with `…1873 VAC` present its entitlements tab now renders
one data row instead of its `t('empty')` row, so that entry needs a
variant update when this fixture lands, or the fixture must land
together with the setup entry's refresh.

## 4. GATES checked (not just row counts)

- Native page gates: `requirePermission('payroll.read')` (redirects when
  absent — loader reproduces verbatim),
  `requireFeatureEnabled(orgId, 'payroll')` (404 when disabled — loader
  reproduces verbatim). Harness user holds `admin`, feature is on: both
  pass.
- Visibility filtering: both scoped loaders filter hidden-subsidiary
  employees through `allowedSubsidiaryIds`, including the entered
  counts, the years list and the blocked map. The harness user holds
  the admin role (unrestricted), so the no-op branch runs — the loader
  passes the same `authz` through, exactly as page.tsx does.
- `payroll.manage`: the Save buttons render for the harness user
  (admin). Both renders share the loader, so the flag is identical —
  but it is genuinely exercised (Save visible, enabled once dirty is
  impossible in a settled-DOM harness — the buttons render disabled
  with no draft, which IS the compared state).

## 5. What could not be expressed (and why)

Nothing structural — the two grids are placed whole, so every
conditional pair, draft state and fetch mutation renders through the
same components on both paths. Three honest limitations:

- The `?year=` picker navigates client-side (`router.push`) and drafts
  are component state: the `?year=2025` variant pins the LOADER's
  year-override path (different `initial` rows), not the client
  navigation. Both renders share the loader, so this is identical —
  but it proves the override computation, not the click.
- Save-button enablement, the error/warning callouts and the
  legacy-prefill action are post-interaction client state (dirty
  drafts, POST responses). The harness compares settled DOMs with no
  interaction, so these branches are not pinned — they render through
  the same component on both paths regardless.
- `ModuleHomeTabs` counts come from `groupTabs` (feature-state
  filtered). Both renders share the loader output, so the strip is
  identical — but a feature-flag change would move both together,
  which conformance cannot distinguish from correct.
