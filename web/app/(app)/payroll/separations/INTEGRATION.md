# /payroll/separations ViewSpec integration handoff

Page: `web/app/(app)/payroll/separations/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.
No `sections.tsx`: nothing is moved or duplicated — `SeparationsView`
stays where it is and both render paths import the same component.

Spec blocks used: `pageHeader` (exists) + `module-home-tabs` (exists in
the registry) + `separations-workspace` (proposed below — does not
exist yet).

## Why one workspace widget

This page is a fully client-interactive workspace wearing one filing's
clothes, not a server-rendered list. Everything below lives in
`FilingWorkspace` client state or bound fetch calls, and none of it is
spec vocabulary:

- the year picker (router push on change) and the filing-card selection
  state with the active-card ring;
- the registry-declared cards: headline-total money line, not-installed
  badge, row-count line — conditional pairs, not presence flags;
- the selected filing's `PagedTable` with client-side search and paging
  plus the appended issue-reason column (reason badge vs "not included"
  fallback per row);
- the download button (disabled-until-declared pair) with fetch error
  callouts, the population/download refusal alerts, and the totals strip;
- the slip drawer, which lazy-loads over fetch on open (there is no
  `?row=` flyout param — the drawer is not URL-addressable) with its own
  loading skeletons, error alert, facsimile body, reason/comment inputs
  and PDF footer.

Decomposing any of that into `table`/`panel` blocks would split one
component's state across two render paths. This is the same call the
parallel-run page made (`parallel-run-workspace` places
`ParallelRunView` whole) and the pay-run wizard made (`pay-run-wizard`
places `RunWizard` whole): the workspace stays whole.

Money is deliberately NOT formatted in the loader. The native component
formats client-side — `useMoney` is browser-locale via `next-intl` +
`MoneyProvider` — so the loader passes the registry rows through and
the component does what it always did. Formatting server-side would
double-format and change the bytes.

The permission and visibility gates ARE load-bearing and are reproduced
verbatim: `payroll.read` via `requirePermission`, the `payroll` feature
gate (404 when disabled), the org business year, the clamped `?year=`
param, the `scopedYearEndFilings` read (null when the caller's
subsidiary scope excludes any row of the year's population — a count is
a disclosure, so the spec path answers the same `notFound()`), the
`separation`-cadence filter with the `installed || rows > 0` convention,
and the module tabs via `groupTabs`. The `Authz`/org id never cross the
spec boundary — the loader consumes them, the widget receives only
`year`, `currentYear` and the function-free sections.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (component already exists in my owned dir):

```tsx
import { SeparationsView } from '../../app/(app)/payroll/separations/SeparationsView'
```

Entry (place beside `parallel-run-workspace`, after the `/* --- pay runs --- */` group):

```tsx
/**
 * Separations workspace. Placed whole rather than decomposed: it owns the
 * year picker, filing-card selection, the population table with its
 * issue-reason column, the fetch download with error callouts, and the
 * fetch-driven slip drawer. The loader hands over the scoped,
 * separation-filtered sections untouched; money stays canonical because
 * the component formats client-side (browser locale).
 */
'separations-workspace': (props) => (
  <SeparationsView
    year={num(props, 'year') ?? 0}
    currentYear={num(props, 'currentYear') ?? 0}
    sections={(props.sections as ComponentProps<typeof SeparationsView>['sections']) ?? []}
  />
),
```

**Exact prop shape the spec passes** (flat props, not one object — three
sibling keys, matching the component's destructured signature
`{ year, currentYear, sections }`):

| prop | type | source |
|---|---|---|
| `year` | `number` (tax year, clamped to 2020–2100 else org business year) | loader `year` |
| `currentYear` | `number` (org business year, never UTC) | loader `currentYear` |
| `sections` | `YearEndFilingSection[]` — `country, key, label, cadence, description \| null, emptyText \| null, installed, data: { columns: { key, label, align?, money? }[], rows: Record<string, string \| number \| null>[], rowKey, totals?: { label, value, money? }[] }, hasSlip, populationRefusal \| null, download: { label, note \| null } \| null, downloadRefusal \| null, issue: { param, idColumn, reasonCodes: { code, label, commentRequired? }[], commentMaxLength, maxSelection } \| null` — function-free by construction (`orgYearEndFilings` strips `population`/`slip.build`/`download.build`) | `scopedYearEndFilings` filtered to `cadence === 'separation' && (installed \|\| rows > 0)` |

`num` follows the existing registry convention (finite numbers only).
No other new imports: `FilingWorkspace` is used inside
`SeparationsView` (already exists), never referenced by the registry
directly. The header reuses the existing `module-home-tabs` widget.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/payroll/separations',
  // One workspace widget: the ROE filing card plus the population table
  // with its reason column. The default render pins the populated branch
  // (the fixture below gives the CA ROE one row); `?year=2025` pins the
  // empty branch (no fixture stubs carry tax_year 2025, so the ROE
  // population is empty and the workspace renders the filing's empty
  // state — a disjoint body from the populated table). The drawer is
  // fetch-driven client state, not URL-addressable, so there is no
  // drawer variant.
  variants: [
    '',
    { query: '?year=2025', expect: 'main h3', minMatches: 1 },
  ],
  expect: 'main table tbody tr',
  minMatches: 1,
},
```

Verified against `openbooks_sim_viewspec` (RLS bypassed; harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, harness user
`viewspec@sim.test` holds the `admin` role — full subsidiary scope, so
the loader's `scopedYearEndFilings` guard passes and the page renders
instead of 404ing):

- `payroll` feature on for the harness org (`settings->'features'->'payroll'` → `true`) — the feature gate passes.
- CA pack is NOT installed (`settings` has no `payroll.countries` key)
  but the convention is `installed || rows > 0`, and the fixture below
  gives the ROE one row, so the card renders.
- `payrollSupportedTaxYears('CA')` is `[2026]` (only `RATES_2026_JAN` /
  `RATES_2026_JUL` are published; `CA_EXTRA_EDITIONS` is empty), so 2026
  builds no `populationRefusal` while `?year=2025` would refuse — but the
  empty branch does not depend on that: no stubs carry `tax_year` 2025
  either way.
- `roeCandidates(org, 2026)` TODAY is `[]`: 0 terminations in 2026, 0
  termination runs, both `committed`-run stubs are `tax_year` 2026 on
  `regular` runs — the join finds nothing, so the page renders the
  `EmptyState` ("No payroll separation filings are declared for this
  organization.") without fixtures and the harness would refuse the
  empty-vs-empty comparison. The fixture below is required.
- After fixtures: `roeCandidates(org, 2026)` returns exactly 1 row
  (Chloe Martin, `terminatedOn` 2026-03-31) → the ROE card shows "1" via
  the `rowCount` key, the card grid renders, and the auto-selected
  section's `PagedTable` renders 1 `tbody tr` (header row lives in
  `thead`, so `tbody tr` = 1). `main h1` (PageHeader title
  "Separations") + the card grid + the table pin the composition.
- `?year=2025`: the loader clamps 2025 (in 2020–2100) and queries 2025;
  fixture stubs are `tax_year` 2026 and Chloe's termination extracts to
  2026, so the ROE population is empty AND `installed` is false → the
  sections list is empty → `FilingWorkspace` returns the bare
  `EmptyState` (an `h3` title — the component always renders one, with no
  `table` sibling; the header stays identical, the body swaps). Disjoint
  from the default variant's table.

GATES (the page 404s without them, and no row count shows that):
`payroll.read` + `payroll` feature — same gates as the already-green
`/payroll/runs` entry; harness admin holds `payroll.read`.

## 3. Fixture SQL (for the coordinator — `scripts/viewspec-fixtures.sql`)

Claims the fresh id block `…1840–1849` (zero hits across
`scripts/viewspec-fixtures.sql`, every `INTEGRATION.md` and
`scripts/viewspec-conformance.mjs`; neighbours `…1830–1839`
parallel-run and `…1901+` wizard-stubs are both taken). Guard-before-insert
throughout per the file's contract. Resolves parties live by name (the
simulator regenerates ids on reseed); fixed ids only for the two new
stubs.

```sql
  -- ---- payroll separations --------------------------------------------------
  --
  -- The simulator never terminates anyone and never pays a termination run,
  -- so roeCandidates(org, 2026) is empty and /payroll/separations renders
  -- the bare no-filings empty state without these — the comparison the
  -- harness refuses. One terminated CA employee (Chloe Martin, Apprentice —
  -- a sim party with an employee_roles row that no other fixture owns) with
  -- a CA profile on the biweekly fixture schedule plus one committed stub
  -- on the existing fixture run …1813 (PAY-00003, committed/regular) gives
  -- the CA ROE exactly one population row. Block …1840-1849.
  --
  -- All three candidate predicates must hold at once: (1) termination in
  -- the year OR a termination run, (2) a stub with tax_year 2026 on a
  -- COMMITTED run (calculated stubs are invisible to the join), (3) a CA
  -- payroll profile (roeCandidates inner-joins employee_payroll_profiles).
  -- Blast radius (checked before claiming): the date + profile + stub move
  -- four other readers, none of which pin the moved values. (1)
  -- /payroll/runs `finalPayCandidates` gains Chloe (profile + terminated)
  -- but that list renders ONLY inside the unopened New Run dialog — the
  -- entry pins `table tbody tr` on the runs list. (2) Parties drawer / run
  -- wizard read one employee's own dates, never Chloe's. (3) Projects
  -- equipment operators exclude terminated staff but the /projects pin is
  -- `table tbody tr` minMatches 3 over a 29-party register, and the
  -- operator list lives in an unopened drawer. (4) Financial-health
  -- headcount includes Chloe only through her final day (the pin is `main
  -- button` tab strip, minMatches 9). (5) Utilization reads
  -- time-tracking, never employment dates.
  declare
    v_chloe uuid;
    v_actor uuid;
  begin
    select id into v_chloe from parties
     where org_id = v_org and display_name = 'Chloe Martin (Apprentice)';
    select id into v_actor from users where org_id = v_org order by created_at limit 1;
    if v_chloe is null or v_actor is null then
      raise notice 'missing Chloe/actor; skipping separations fixtures';
      return;
    end if;

    -- The interruption of earnings. Chloe's employee_roles row exists with
    -- terminated_on null — stamp it; the guard is the null itself, so a
    -- re-run is a no-op and the UPDATE never fights another fixture.
    update employee_roles set terminated_on = date '2026-03-31'
     where org_id = v_org and party_id = v_chloe and terminated_on is null;

    -- Chloe's CA payroll profile on the biweekly fixture schedule (…1801,
    -- frequency `biweekly` — a frequency roeRecord accepts, though only
    -- the population matters for the pin). Fixed id …1841; the guard is
    -- (org_id, employee_party_id) so a re-run is a no-op even though
    -- profiles carry no unique key on the employee.
    insert into employee_payroll_profiles
      (id, org_id, employee_party_id, pay_schedule_id, province, pay_basis,
       country, stub_delivery, payment_method, is_active)
    select '00000000-0000-7000-9000-000000001841', v_org, v_chloe,
           '00000000-0000-7000-9000-000000001801', 'ON', 'hourly',
           'CA', 'email', 'eft', true
     where not exists (select 1 from employee_payroll_profiles
                        where org_id = v_org and employee_party_id = v_chloe);

    -- The committed stub that makes her a candidate. Run …1813 is the
    -- existing committed fixture run (pay_date 2026-03-11); the stub is a
    -- second employee on that run, so no run header changes. (org_id,
    -- employee_party_id) is not unique but (pay_run_document_id,
    -- employee_party_id) is — the guard names THAT, so re-runs stay
    -- silent. country/'unknown' + filing_account/'unknown' satisfy the
    -- evidence CHECKs with the unknown-source branch (no pack is installed
    -- in the sim tenant, exactly like the wizard-stub block); net_pay >= 0
    -- holds; no cheque_number so that CHECK is vacuous.
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
       currency_code, gross, pensionable_earnings, insurable_earnings,
       net_pay, employer_cost, vacation_accrued, factors,
       country_source, filing_account_source)
    select '00000000-0000-7000-9000-000000001840', v_org,
           '00000000-0000-7000-9000-000000001813', v_chloe, 'ON',
           26, date '2026-03-11', 2026, 0, 0,
           'USD', 2800.00, 2800.00, 2800.00,
           2100.00, 2960.00, 112.00, '{"T": "355.00", "C": "150.00", "EI": "48.00"}',
           'unknown', 'unknown'
     where not exists (select 1 from pay_stubs
                        where pay_run_document_id = '00000000-0000-7000-9000-000000001813'
                          and employee_party_id = v_chloe);
  end;
```

Why this shape and not a smaller one:

- A `termination`-type run instead of the date stamp would ALSO create
  a candidate (the `or r.run_type = 'termination'` branch), but
  inventing a whole run header + document for a fixture is heavier and
  the date stamp is the ordinary real-world path (anyone with a
  termination date in the year).
- The stub must sit on a COMMITTED run: `calculated` stubs are invisible
  to `roeCandidates` (the join filters `run_status = 'committed'`), and
  …1813 is the only committed fixture run.
- The profile is mandatory, not optional: `roeCandidates` inner-joins
  `employee_payroll_profiles`, so a profile-less Chloe yields ZERO rows.

Expected post-fixture reads (RLS bypassed):

- `select count(*) … roeCandidates-equivalent` → 1 (`Chloe Martin
  (Apprentice)`, `terminated_on` 2026-03-31, stub `tax_year` 2026 on a
  committed run, CA profile).
- `/payroll/separations` default variant: 1 ROE card ("Records of
  Employment", rowCount 1), 1 `main table tbody tr`.
- `/payroll/separations?year=2025`: bare `EmptyState` (`main h3` ≥ 1,
  zero `tbody tr`).
- `/payroll/runs` default pin unchanged (3 `tbody tr` on the runs
  list; the dialog stays closed).

## 4. What the spec does NOT cover (explicitly shared instead)

- Everything below the header: the year picker, filing cards,
  population table + reason column, download callouts, totals strip and
  slip drawer all live in `FilingWorkspace` / `SeparationsView` (client
  state + fetch). Per the brief, a conditional pair is a component, and
  this page is nothing BUT conditional pairs — hence one widget, the
  same call parallel-run and the run wizard made.
- `t('title')` / `t('description')` / `t('noFilings')` (via the
  `emptyTitle` prop) are the only message keys the loader touches; all
  three exist in `web/messages/en/payroll.json` under `separations`
  (verified). Every other string (`payroll.filings/*`, the ROE labels,
  reason codes) is owned by the shared component in both paths.
- `notFound()` on a scope-denied caller: the loader calls it exactly
  where page.tsx did, before any spec is built. The spec has no
  not-found branch — same as the close/subcontracts precedent.
- The `__viewspec` search param is consumed by the branch and passed to
  `ModuleView` as `searchParams`; the loader reads only `sp.year` from
  it, exactly like the native page.
- No `sections.tsx`: nothing composite needed to move — the workspace
  component IS the composite, and both paths share the single
  implementation in `SeparationsView.tsx` + `../_ui/filing-workspace.tsx`.
