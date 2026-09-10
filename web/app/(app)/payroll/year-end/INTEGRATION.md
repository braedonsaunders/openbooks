# /payroll/year-end ViewSpec integration handoff

Page: `web/app/(app)/payroll/year-end/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.
No `sections.tsx`: nothing is moved or duplicated — `YearEndView`
stays where it is and both render paths import the same component.

Spec blocks used: `pageHeader` (exists) + `module-home-tabs` (exists in
the registry) + `year-end-workspace` (proposed below — does not exist
yet).

## Why one workspace widget

This page is a thin shell over the shared filing workspace
(`../_ui/filing-workspace.tsx`), a fully client-interactive surface —
not a server-rendered list. Everything below the header lives in
`FilingWorkspace` client state or bound fetch calls, and none of it is
spec vocabulary:

- the year picker (`router.push` on change — a navigation, not a spec
  filter);
- the selected filing (`useState`, defaulting to the first section with
  rows) and the two headed cadence groups the surface splits on;
- the issue declarations (the ROE's per-row reason picker + comment),
  the file download (fetch POST/GET with max-selection and 422 refusal
  callouts), and the amendment lifecycle (record-original POST, per-row
  correction review, correction forms) — all bound server actions over
  fetch, not named routes;
- the slip drawer, which lazy-loads over fetch on open (there is no
  `?row=` flyout param — the drawer is not URL-addressable);
- every `PagedTable` cell: money formatted client-side through
  `useMoney` (browser locale), null cells as em-dashes, the lifecycle
  status badge beside the figures, and the reason badge — conditional
  pairs and multi-element cells a spec cannot express.

Decomposing the tables into `table` blocks would split one component's
state across two render paths and reimplement its conditional pairs as
spec constructs that do not exist. This is the same call the
parallel-run page made (`parallel-run-workspace` places
`ParallelRunView` whole): the workspace stays whole.

Money, dates and counts are deliberately NOT formatted in the loader.
The native component formats them client-side — `useMoney` is
browser-locale via `next-intl` + `MoneyProvider`, and the totals grid
renders the canonical numeric text through it. Per the trap list, the
loader passes the section rows/totals through untouched and the
component does what it always did. Formatting them server-side would
double-format and change the bytes.

The permission gates ARE load-bearing and are reproduced verbatim: the
`payroll.read` gate, the `payroll` feature gate (404 when disabled),
the business-day year with its clamped `?year=` override
(`2020–2100`, else business today), the scoped filings read
(`scopedYearEndFilings(authz, year)` + `if (!filings) notFound()` — a
restricted caller whose scope excludes any row of the year's
population gets the route's not-found answer here too), the annual /
quarterly / separation cadence split with the `installed || rows > 0`
guard, and the module tabs via `groupTabs`. The `Authz`/org id never
cross the spec boundary — the loader consumes them, the widget
receives only the year pair + the rows.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (component already exists in my owned dir):

```tsx
import { YearEndView } from '../../app/(app)/payroll/year-end/YearEndView'
```

Entry (place after the `/* --- pay runs --- */` group, beside
`parallel-run-workspace`):

```tsx
/**
 * Year-end filing workspace. Placed whole rather than decomposed: it owns
 * filing selection, the year picker, issue declarations, file download,
 * the amendment lifecycle, the slip drawer, and every conditional cell
 * pair. The loader hands over the scoped sections untouched; money stays
 * canonical numeric text because the component formats client-side
 * (browser locale).
 */
'year-end-workspace': (props) => (
  <YearEndView
    year={num(props, 'year') ?? new Date().getFullYear()}
    currentYear={num(props, 'currentYear') ?? new Date().getFullYear()}
    sections={(props.sections as ComponentProps<typeof YearEndView>['sections']) ?? []}
  />
),
```

`num` follows the existing registry convention (like `str`); the
`?? new Date().getFullYear()` fallback mirrors how other whole-widget
entries degrade on absent props and is unreachable in practice (the
loader always supplies both years).

**Exact prop shape the spec passes** (flat props, three sibling keys,
matching the component's destructured signature
`{ year, currentYear, sections }`):

| prop | type | source |
|---|---|---|
| `year` | `number` (clamped `?year=` override, else business year) | loader, verbatim from page.tsx |
| `currentYear` | `number` (business year) | loader, verbatim from page.tsx |
| `sections` | `YearEndFilingSection[]` — `{ country, key, label, cadence, description: string \| null, emptyText: string \| null, installed: boolean, data: { rowKey, columns: { key, label, align?, money? }[], rows: Record<string, string \| number \| null>[], totals?: { label, value, money? }[] }, hasSlip: boolean, populationRefusal: string \| null, download: { label, note: string \| null } \| null, downloadRefusal: string \| null, issue: { param, idColumn, reasonCodes: readonly { code, label, commentRequired? }[], commentMaxLength, maxSelection } \| null }[]` | `scopedYearEndFilings(authz, year)` filtered to `cadence !== 'separation' && (installed \|\| rows.length > 0)`, verbatim from page.tsx |

The section type is plain JSON (strings, numbers, nulls, readonly
arrays) — serializable as-is. No functions cross the boundary: the
population builders, slip builders, file builders and amendment
workflows stay inside the engine/registry and the fetch routes; the
spec carries only their already-resolved outputs.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/payroll/year-end',
  // One workspace widget: the year picker, the annual filing cards, the
  // selected filing's population table and its totals. The fixture block
  // below puts one committed CA stub on the existing committed run
  // (PAY-00003, …1813), so the default render carries the T4 section
  // (1 row) with its PagedTable. The slip drawer is fetch-driven client
  // state, not URL-addressable, so there is no drawer variant.
  variants: [
    '',
    // 2025 is untranscribed in every pack, so every section has zero
    // rows and the `installed || rows > 0` guard filters them all out:
    // the page renders its `noFilings` empty state. This pins the
    // loader's year-override + filter logic, not just the populated
    // branch — a clamping divergence would show rows here on one path.
    { query: '?year=2025', expect: 'main div', minMatches: 1 },
  ],
  expect: 'main table tbody tr',
  minMatches: 1,
},
```

Verified against `openbooks_sim_viewspec` (RLS bypassed; harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, harness user
`viewspec@sim.test` holds the `admin` role):

- `payroll` feature on for the harness org
  (`settings->'features'->'payroll'` → `true`) — the feature gate passes.
- 2026 is `published` for the CA pack (T4127 122nd edition),
  Revenu Québec (TP-1015.F-V 2026) and the US pack (Pub 15-T 2026) —
  no pack refuses the year by name.
- Declared non-separation filings: CA `t4` (annual), CA `rl1`
  (annual), US `941` (quarterly), US `w2` (annual). No pack is
  installed (`settings->'payroll'->'countries'` is null), so every
  section has `installed = false` and the page's
  `installed || rows.length > 0` guard decides visibility by rows alone.
- T4/RL-1 populations read COMMITTED stubs only, and the tenant's 2
  real stubs sit on calculated run `…1811` — so the T4 returns 0 rows
  today and the US 941/W-2 return 0 rows (no US stubs at all). The
  fixture below is required (the harness refuses to compare
  empty-vs-empty).
- `expect: 'main table tbody tr', minMatches: 1`: after fixtures, the
  T4 section is the default-selected filing (first section with rows)
  and its population table holds 1 row. `PagedTable` renders a real
  `<table>` whenever rows are non-empty (only the empty case returns
  the bare paragraph), so the selector matches it.
- `?year=2025` variant: CA 2025 is an untranscribed year
  (`CA_EXTRA_EDITIONS` is empty — only the 2026 T4127 editions exist)
  and the US pack carries 2026 only, so every filing builds an empty
  population (CA ones with a named `populationRefusal`, US ones
  empty). With no pack installed, the `installed || rows > 0` guard
  then filters every section out and the page renders the `noFilings`
  empty state — a genuine second structural branch (EmptyState vs
  cards + table), pinning the loader's year-override and filter logic.
  Note the refusal callout itself is NOT pinned by this variant: a
  refused section only renders its callout when it passes the guard
  (installed pack), and no pack is installed in the harness tenant.
  Installing one would mean editing the org's real settings in a
  fixture — out of proportion for a callout both paths render from
  the same shared component.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims the fresh id block `…1840–1849` (zero hits for `00000000184`
across `scripts/viewspec-fixtures.sql`, all `INTEGRATION.md` files and
`scripts/viewspec-conformance.mjs`). Guard-before-insert throughout;
`on conflict (id)` owns the stub/line ids (pkey on `id`, same
convention as the confirmed `pay_stubs_pkey` / `pay_stub_lines_pkey`).

```sql
  -- ---- year-end T4 population ------------------------------------------------
  --
  -- The simulator never commits payroll, so /payroll/year-end renders its
  -- empty state without these: one committed CA stub on the existing
  -- committed run …1813 (PAY-00003, committed/regular, period
  -- 2026-02-21–2026-03-06, pay date 2026-03-11) with the minimum rows the
  -- T4 chain joins against. The stub reuses a live sim party (the FK to
  -- parties holds), the ON-profile the …1901 block already seeds for that
  -- party, and the BASE component (…1901) for the earning line. One stub
  -- line carries the BASE link and one is component-free, so both
  -- taxable-income join branches render. Guard before insert: the run and
  -- party must exist, and the fixed ids must be absent — re-runs are
  -- no-ops.
  declare
    v_emp uuid;
  begin
    select id into v_emp from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    if v_emp is null then
      raise notice 'missing fixture party; skipping year-end fixtures';
      return;
    end if;
    if not exists (select 1 from pay_runs
                    where org_id = v_org
                      and document_id = '00000000-0000-7000-9000-000000001813'
                      and run_status = 'committed') then
      raise notice 'missing committed fixture run; skipping year-end fixtures';
      return;
    end if;

    -- One committed CA stub on run …1813. country/filing columns cite the
    -- legacy-region branch of the evidence CHECKs (country = 'CA',
    -- country_source = 'legacy_region', filing_account_source =
    -- 'insertion'): the live sim stubs use exactly this vocabulary, and it
    -- passes both evidence assertions (no null country, no 'unknown'
    -- filing source) so t4Slips builds instead of refusing. Province ON
    -- (non-Quebec: no QPIP arm), filing_account_id null (the unassigned
    -- bucket — t4Returns groups it without a filing-accounts row).
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
       currency_code, gross, pensionable_earnings, insurable_earnings,
       net_pay, employer_cost, vacation_accrued, factors,
       country, country_source, filing_account_source)
    values
      ('00000000-0000-7000-9000-000000001840', v_org,
       '00000000-0000-7000-9000-000000001813', v_emp, 'ON',
       26, date '2026-03-11', 2026, 0, 0,
       'USD', 3400.00, 3400.00, 3400.00,
       2510.75, 3620.40, 136.00, '{"T": "441.20", "C": "186.85", "EI": "61.20"}',
       'CA', 'legacy_region', 'insertion')
    on conflict (id) do nothing;

    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, hours, rate,
       amount, sequence)
    values
      ('00000000-0000-7000-9000-000000001841', v_org,
       '00000000-0000-7000-9000-000000001840',
       '00000000-0000-7000-9000-000000001901', 'earning',
       'Regular hours', 80, 42.50, 3400.00, 1),
      ('00000000-0000-7000-9000-000000001842', v_org,
       '00000000-0000-7000-9000-000000001840', null, 'deduction',
       'Income tax', null, null, -441.20, 2)
    on conflict (id) do nothing;
  end;
```

Notes on the fixture design:

- Row-count effect after fixtures land: T4 population → 1 slip (the
  fixture stub is the tenant's only committed CA stub) → the T4 section
  has 1 row and becomes the default-selected filing (first section
  with rows; the RL-1 needs a QC-profiled employee and the US filings
  need US stubs, so both stay empty). Hence `minMatches: 1` on
  `main table tbody tr`.
- The `?year=2025` variant needs NO fixture: 2025 builds zero rows
  in every pack regardless of data, so the guard filters everything
  and the page renders the `noFilings` empty state.
- `t4Summary`'s employer-side subquery joins `pay_components` on the
  line's `component_id` (inner join) — the fixture's earning line
  carries the BASE component (`country` CA per the …1901 block), so a
  future employer-contribution line would resolve; with earning +
  deduction lines only, employer CPP/EI sum to 0 via `num()` (null →
  "0"), and `remitted` is 0 (no posted `payrollRemittance` bills).
  Totals render 6 tiles with real slip-driven values — the same
  numbers on both paths, from the same loader.
- `capAnnualEarnings` consumes per-employee caps across the year's
  slips: one slip of 3400.00 insurable/pensionable is far below the
  2026 MIE/YAMPE, so boxes 24/26 pass through uncapped. A second
  fixture slip for the same employee would move the caps — one slip
  keeps the expected values trivially recomputable.
- Money arrives as canonical numeric text (`sum()` over numerics →
  Postgres string form, `add()` in money.ts) and the component formats
  client-side — no loader formatting, no double-format drift.
- Why not reuse the `…1911/1912` stubs: those sit on calculated run
  `…1811`, which the T4's `committed` join excludes by construction.
  Moving them would break the run-wizard conversion's row counts; a
  new stub on the already-committed `…1813` run is additive to every
  existing entry.
- `employee_count` on run `…1813` stays `1` with one fixture stub
  naming one employee — no skew (same cosmetic note the wizard
  conversion records for its two-stubs/one-count case does not apply
  here).

## 4. GATES checked (not just row counts)

- Native page gates: `requirePermission('payroll.read')` (redirects
  when absent — loader reproduces verbatim),
  `requireFeatureEnabled(orgId, 'payroll')` (404 when disabled —
  loader reproduces verbatim). Harness user holds `admin`, feature is
  on: both pass.
- Visibility filtering: `scopedYearEndFilings` applies
  `guardPayrollYearEndFilings` (whole-population 404 for a restricted
  caller), and the loader reproduces the `if (!filings) notFound()`
  answer verbatim. The harness user holds the admin role
  (`subsidiary_restriction {"mode": "all"}`), so
  `allowedSubsidiaryIds` is null and the unrestricted branch runs.
- `web/lib/payroll-page-scope.test.ts` pins this page to
  `scopedYearEndFilings(authz, year)` + `if (!filings) notFound()` and
  forbids `orgYearEndFilings` — the loader uses the scoped read, so
  the test keeps passing. (The test reads `page.tsx`, which still
  contains the native branch verbatim.)
- New/empty branches: without fixtures the page shows the `noFilings`
  empty state (no pack installed, no committed stubs); with fixtures
  it shows the T4 section with 1 row. The default variant pins the
  populated branch (the harness refuses empty-vs-empty); the empty
  branch is the same `EmptyState` in both renders by construction
  (one shared component).

## 5. What could not be expressed (and why)

1. **The workspace itself.** `YearEndView` / `FilingWorkspace` —
   filing selection, the year picker, issue declarations, file
   download, the amendment lifecycle, the slip drawer, `PagedTable`
   search/paging — is placed whole through `year-end-workspace` (§1).
   No new ViewSpec vocabulary needed; nothing is re-proposed beyond
   the single registry entry.
2. **No drawer variant.** The slip drawer opens from client state
   over fetch, not from a URL param, so no query string can pin it
   for the harness. Both renders share the component, so the drawer
   code is identical by construction.
3. **No per-filing variants beyond `?year=2025`.** The RL-1 needs a
   QC-profiled employee with committed stubs, the 941/W-2 need US
   stubs, and the ROE lives on `/payroll/separations` (a separate
   conversion may claim those populations). Seeding three more
   country populations to light up every card would triple the
   fixture for branches that are the same card component with
   different labels — the T4 exercises the card, the table, the
   totals, the download button and the lifecycle bar structurally.
4. **No amendment-lifecycle variant.** Recording an original is a
   fetch POST behind the drawer's lifecycle bar; no query string pins
   the `ready` state. The bar renders from the same component on both
   paths.
5. **Business-year drift in the picker and default year.** The six
   picker years and the default `year` key off `businessToday(orgId)`;
   both paths compute them in the same loader, so any drift moves
   both renders together (same note as the `/payroll` cockpit's
   tax-year heads-up). If the calendar turns past 2026, the default
   variant's populated branch moves with it — the `?year=2025`
   empty-state variant is year-pinned and stable.
