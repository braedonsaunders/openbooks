# /payroll/parallel-run ViewSpec integration handoff

Page: `web/app/(app)/payroll/parallel-run/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.
No `sections.tsx`: nothing is moved or duplicated — `ParallelRunView`
stays where it is and both render paths import the same component.

Spec blocks used: `pageHeader` (exists) + `module-home-tabs` (exists in
the registry) + `parallel-run-workspace` (proposed below — does not
exist yet).

## Why one workspace widget

This page is a fully client-interactive workspace, not a server-rendered
list. Everything below lives in `ParallelRunView.tsx` client state or
bound fetch calls, and none of it is spec vocabulary:

- the two picker selects with derived defaults (`registers[0]`,
  period-matched suggestion) and the period-mismatch / empty-register /
  unmapped-columns notices derived from the *selected* values;
- the compare POST (`/api/payroll/parallel-run`) with toast feedback;
- the findings drawer, which lazy-loads over fetch on open (there is no
  `?comparison=` flyout param — the drawer is not URL-addressable);
- the tolerance editor drawer with its own POST/DELETE cycle;
- the discard-register DELETE;
- both `PagedTable`s with client-side search and paging.

The tables cannot be decomposed into `table` blocks either: their cells
are conditional pairs (status badge tone, result badge tone, red-vs-grey
difference, `not present`-vs-amount, `exact`-vs-`±` tolerance,
`comparedEmployeeCount === 0` red population) plus multi-element cells
(the differences cell stacks three optional spans; the register name
cell stacks title + provider/period line; the component cell stacks
label + kind/source line). A spec cannot express any of that, and
splitting the tables out would put one component's state in two places.
This is the same call the pay-run wizard page made (`pay-run-wizard`
places `RunWizard` whole): the workspace stays whole.

Money, dates and counts are deliberately NOT formatted in the loader.
The native component formats them client-side — `useMoney` is
browser-locale via `next-intl` + `MoneyProvider`, and `comparedAt` is
sliced in the cell (`row.comparedAt.slice(0, 16).replace('T', ' ')`).
Per the trap list, the loader passes the canonical store strings
through (`normalizeMoney` four-decimal text from the store readers) and
the component does what it always did. Formatting them server-side
would double-format and change the bytes.

The permission gate IS load-bearing and is reproduced: `payroll.read`
via `requirePermission`, the `payroll` feature gate (404 when
disabled), the `payroll.manage` flag for compare/discard/tolerances,
and the module tabs via `groupTabs` (which filters on the org's
feature state). The `Authz`/org id never cross the spec boundary — the
loader consumes them, the widget receives only rows + the boolean.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (component already exists in my owned dir):

```tsx
import { ParallelRunView } from '../../app/(app)/payroll/parallel-run/ParallelRunView'
```

Entry (place after the `/* --- pay runs --- */` group, beside `pay-run-wizard`):

```tsx
/**
 * Parallel-run workspace. Placed whole rather than decomposed: it owns
 * picker state, fetch mutations (compare / discard / tolerances), the
 * findings drawer, and every conditional cell pair. The loader hands over
 * the store rows untouched; money stays canonical four-decimal text
 * because the component formats client-side (browser locale).
 */
'parallel-run-workspace': (props) => (
  <ParallelRunView
    registers={props.registers as ComponentProps<typeof ParallelRunView>['registers']}
    runs={props.runs as ComponentProps<typeof ParallelRunView>['runs']}
    comparisons={props.comparisons as ComponentProps<typeof ParallelRunView>['comparisons']}
    tolerances={props.tolerances as ComponentProps<typeof ParallelRunView>['tolerances']}
    slots={props.slots as ComponentProps<typeof ParallelRunView>['slots']}
    canManage={props.canManage === true}
  />
),
```

**Exact prop shape the spec passes** (flat props, not one object — six
sibling keys, matching the component's destructured signature
`{ registers, runs, comparisons, tolerances, slots, canManage }`):

| prop | type | source |
|---|---|---|
| `registers` | `{ id, name, providerName: string \| null, periodStart, periodEnd, payDate: string, employeeCount, amountCount: number, statedGross, statedNet: string (canonical numeric text), unmappedColumns: { column: string, valuedRows: number }[] }[]` | `priorRegisters(orgId)` verbatim (incl. `currencyCode`, `sourceFileName`, `updatedAt` — the component ignores the extras) |
| `runs` | `{ documentId, label, periodStart, periodEnd, payDate, runStatus: string, employeeCount: number }[]` | `comparablePayRuns(orgId)` verbatim (calculated + committed only) |
| `comparisons` | `{ id, registerId, registerName, payRunDocumentId, payRunNumber, status: string, blockedReason: string \| null, comparedAt: string (timestamptz text), prior/our/comparedEmployeeCount, match/withinTolerance/difference/oneSidedCount: number, prior/ourGross, prior/ourNet, gross/netDifference, unattributedNet: string, tolerancesApplied: { kind, slot, tolerance, reason }[], unmappedColumns }[]` | `parallelComparisons(orgId, {})` verbatim |
| `tolerances` | `{ id?, kind, slot, tolerance: string, reason: string }[]` | `parallelTolerances(orgId)` verbatim |
| `slots` | `{ fieldKey, kind, slot, label: string }[]` | `comparableSlots(orgId)` mapped to the four fields (drops `componentId`/`systemKey`/`code`, exactly as page.tsx does) |
| `canManage` | `boolean` | `can(authz, 'payroll.manage')` |

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/payroll/parallel-run',
  // One workspace widget: the compare selects (register + run pickers),
  // the comparisons table and the registers table. The fixture block
  // below seeds one prior register (2 stubs, 2 amounts, stated totals,
  // one unmapped column) plus one `differences` comparison with one
  // tolerance applied — so the default render carries 1 comparison row
  // and 1 register row. No drawer variant: the findings drawer is
  // fetch-driven client state, not URL-addressable.
  variants: [''],
  expect: 'main table tbody tr',
  minMatches: 2,
},
```

Verified against `openbooks_sim_viewspec` (RLS bypassed; harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, harness user
`viewspec@sim.test` holds the `admin` role):

- `payroll` feature on for the harness org (`settings->'features'->'payroll'` → `true`) — the feature gate passes.
- `pay_components` in harness org: 2 (so `comparableSlots` is non-empty).
- `comparablePayRuns` real rows: `PAY-00001` (calculated), `PAY-00002` (calculated), `PAY-00003` (committed) — the run picker is populated without fixtures.
- `payroll_prior_registers` / `payroll_parallel_comparisons` / `payroll_parallel_tolerances` in the harness org: **0 rows each** — the sim never imports a register, so the page renders two empty states today and the fixture below is required (the harness refuses to compare empty-vs-empty).
- `expect: 'main table tbody tr', minMatches: 2`: after fixtures, the comparisons table holds 1 row and the registers table holds 1 row = 2 `tbody tr` total. `PagedTable` renders a real `<table>` whenever rows are non-empty (only the empty case returns the bare paragraph), and both tables are non-empty, so the selector matches both.

## 3. Fixture SQL (for the coordinator — `scripts/viewspec-fixtures.sql`)

Claims the fresh id block `…1830–1839` (zero hits across
`scripts/viewspec-fixtures.sql`, all `INTEGRATION.md` files and
`scripts/viewspec-conformance.mjs`). Guard-before-insert throughout:
`payroll_prior_registers` has a UNIQUE `(org_id, name)` constraint, so
`ON CONFLICT (id)` alone would raise on re-run — the guard owns
idempotence. No triggers exist on any of the four tables (checked
`pg_trigger`: none non-internal), but the guard is still used per the
file's contract.

```sql
  -- ---- parallel run ----------------------------------------------------------
  --
  -- The simulator never imports a prior register, so /payroll/parallel-run
  -- renders two empty states without these: one register (2 stubs, 2
  -- amounts, one unmapped column) plus one `differences` comparison with
  -- one finding and one tolerance applied. The register pay_date matches
  -- the first sim pay run (PAY-00001, pay_date 2026-02-11), so the native
  -- period-suggestion path resolves. GUARD before insert: the unique key
  -- is (org_id, name), not the id — ON CONFLICT (id) alone would raise on
  -- a re-run, so the guard owns idempotence.
  declare
    v_reg uuid := '00000000-0000-7000-9000-000000001830';
    v_cmp uuid := '00000000-0000-7000-9000-000000001831';
    v_payrun uuid;
    v_actor uuid;
    v_emp uuid;
  begin
    select document_id into v_payrun from pay_runs
     where org_id = v_org and document_id = '00000000-0000-7000-9000-000000001811';
    select id into v_actor from users where org_id = v_org order by created_at limit 1;
    select id into v_emp from parties
     where org_id = v_org and is_active
     order by display_name limit 1;
    if v_payrun is null or v_actor is null or v_emp is null then
      raise notice 'missing pay run/actor/party; skipping parallel-run fixtures';
      return;
    end if;

    insert into payroll_prior_registers
      (id, org_id, name, provider_name, period_start, period_end, pay_date,
       currency_code, source_file_name, unmapped_columns, created_by, updated_by)
    select v_reg, v_org, 'ViewSpec prior register', 'LegacyCo',
           date '2026-01-24', date '2026-02-06', date '2026-02-11',
           'USD', 'legacy-jan.csv', '[{"column": "parking", "valuedRows": 2}]'::jsonb,
           v_actor, v_actor
     where not exists (select 1 from payroll_prior_registers
                        where org_id = v_org and name = 'ViewSpec prior register');

    insert into payroll_prior_stubs
      (id, org_id, register_id, employee_party_id, employee_label,
       gross, net_pay, employer_cost, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001832', v_org, v_reg, v_emp,
           'ViewSpec Employee', 5200.0000, 4000.0000, 600.0000, v_actor, v_actor
     where exists (select 1 from payroll_prior_registers where id = v_reg)
       and not exists (select 1 from payroll_prior_stubs
                        where id = '00000000-0000-7000-9000-000000001832');

    insert into payroll_prior_amounts
      (id, org_id, prior_stub_id, component_id, kind, slot, source_column,
       amount, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001833', v_org,
           '00000000-0000-7000-9000-000000001832', null, 'earning',
           'code:BASE', 'Base Pay', 5200.0000, v_actor, v_actor
     where exists (select 1 from payroll_prior_stubs
                    where id = '00000000-0000-7000-9000-000000001832')
       and not exists (select 1 from payroll_prior_amounts
                        where id = '00000000-0000-7000-9000-000000001833');

    insert into payroll_parallel_tolerances
      (id, org_id, kind, slot, tolerance, reason, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001834', v_org, 'total',
           'net_pay', 1.0000, 'ViewSpec: legacy rounds net to the cent', v_actor, v_actor
     where not exists (select 1 from payroll_parallel_tolerances
                        where org_id = v_org and kind = 'total' and slot = 'net_pay');

    insert into payroll_parallel_comparisons
      (id, org_id, register_id, pay_run_document_id, status,
       prior_employee_count, our_employee_count, compared_employee_count,
       prior_only_employee_count, our_only_employee_count,
       match_count, within_tolerance_count, difference_count, one_sided_count,
       prior_gross, our_gross, prior_net, our_net,
       prior_employer_cost, our_employer_cost,
       unattributed_gross, unattributed_net, unattributed_employer_cost,
       tolerances_applied, unmapped_columns, blocked_reason, created_by, updated_by)
    select v_cmp, v_org, v_reg, v_payrun, 'differences',
           1, 1, 1,
           0, 0,
           0, 1, 1, 0,
           5200.0000, 5200.0000, 4000.0000, 3999.5000,
           600.0000, 600.0000,
           0.0000, 0.0000, 0.0000,
           '[{"kind": "total", "slot": "net_pay", "tolerance": "1.0000", "reason": "ViewSpec: legacy rounds net to the cent"}]'::jsonb,
           '[{"column": "parking", "valuedRows": 2}]'::jsonb,
           null, v_actor, v_actor
     where exists (select 1 from payroll_prior_registers where id = v_reg)
       and not exists (select 1 from payroll_parallel_comparisons where id = v_cmp);

    insert into payroll_parallel_findings
      (id, org_id, comparison_id, employee_party_id, employee_name, kind,
       slot, slot_label, classification, prior_amount, our_amount,
       difference, tolerance_applied, source_column, sequence, created_by, updated_by)
    select '00000000-0000-7000-9000-000000001835', v_org, v_cmp, v_emp,
           'ViewSpec Employee', 'earning',
           'code:BASE', 'Base pay', 'difference', 5200.0000, 5199.5000,
           0.5000, 0.0000, 'Base Pay', 100, v_actor, v_actor
     where exists (select 1 from payroll_parallel_comparisons where id = v_cmp)
       and not exists (select 1 from payroll_parallel_findings
                        where id = '00000000-0000-7000-9000-000000001835');
  end;
```

Notes on the fixture design:

- `status: 'differences'` exercises the red badge branch. `clean` and
  `clean_within_tolerance` are one enum value away in the same badge
  component and differ only in tone class + label — they are not
  separate structural branches. `no_comparable_data` renders only the
  `blockedReason` banner + empty findings; by the "a variant that
  cannot differ from the default is not coverage" rule it adds no
  structural coverage beyond what the `blockedReason: null` default
  already proves (the banner is a presence flag either way).
- `payroll_parallel_findings.employee_party_id` references
  `(org_id, employee_party_id) → parties(org_id, id)` with ON DELETE
  CASCADE — the fixture reuses a live sim party, so the FK holds.
- `payroll_parallel_comparisons.pay_run_document_id` references
  `documents(org_id, id)` — pinned to the `…1811` fixture row the
  payroll block already seeds (`PAY-00001`, calculated, `pay_date
  2026-02-11`), which is also what makes the native period-suggestion
  resolve in the harness tenant.
- `payroll_prior_amounts.component_id` is nullable with ON DELETE
  RESTRICT — left null (a mapped-to-nothing import column still
  compares by `(kind, slot)`; null avoids pinning a component id that
  another fixture could reseed).
- The register's `(org_id, name)` guard runs first; the stub/amount/
  comparison/finding guards key on the fixed ids. Re-runs are no-ops.
- Row-count effect after fixtures land: `priorRegisters` → 1 row
  (registers table: 1 `tbody tr`), `parallelComparisons` → 1 row
  (comparisons table: 1 `tbody tr`), hence `minMatches: 2` on
  `main table tbody tr`.

## 4. GATES checked (not just row counts)

- Native page gates: `requirePermission('payroll.read')` (redirects when
  absent — loader reproduces verbatim), `requireFeatureEnabled(orgId,
  'payroll')` (404 when disabled — loader reproduces verbatim).
  Harness user holds `admin`, feature is on: both pass.
- Visibility filtering: `priorRegisters` / `parallelComparisons` filter
  hidden-subsidiary rows through `allowedSubsidiaryIds`. The harness
  user holds the admin role (`subsidiary_restriction {"mode": "all"}`),
  so `allowedSubsidiaryIds` is null and the unrestricted branch runs —
  the loader passes no scope, exactly as page.tsx does (it calls the
  stores with `orgId` alone).
- New/empty branches: with zero registers the native page shows the
  `noRegisters` note; with fixtures it shows one register row + one
  comparison row. The default variant pins the populated branch (the
  harness refuses empty-vs-empty); the empty branch is the same
  `PagedTable` empty paragraph in both renders by construction.

## 5. What could not be expressed (and why)

1. **The workspace itself.** `ParallelRunView` — picker state, the
   period suggestion, compare/discard/tolerance fetch mutations, the
   findings drawer, `PagedTable` search/paging — is placed whole
   through `parallel-run-workspace` (§1). No new ViewSpec vocabulary
   needed; nothing is re-proposed beyond the single registry entry.
2. **No drawer variant.** The findings drawer opens from client state
   over fetch, not from a URL param, so no query string can pin it for
   the harness. Both renders share the component, so the drawer code is
   identical by construction.
3. **No `clean` / `tolerance` / `no_comparable_data` variants.** Per
   the coverage rule, badge-tone swaps are not structural branches,
   and the blocked-reason banner is a presence flag. One `differences`
   comparison with one tolerance applied and one unmapped column
   exercises every structural element (banner absent, unmapped panel
   present, tolerance panel present, tiles, both tables).
