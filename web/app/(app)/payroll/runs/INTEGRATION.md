# /payroll/runs ViewSpec integration handoff

Page: `web/app/(app)/payroll/runs/` — owner files are `view.ts` (+ this file)
and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`: the
page needs no composite cells (see §4).

Spec widgets used: `pageHeader` and `module-home-tabs` blocks (both exist),
plus `new-pay-run` and `pay-run-row-actions` (proposed below — neither
exists in the registry yet). The list itself goes through the existing
`record-list-view` widget + `RecordListSlot` (already integrated).

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed (all already exist as components):

```tsx
import { NewRunButton } from '../../app/(app)/payroll/_ui/NewRunButton'
import Link from 'next/link' // already imported — reuse for the row action
import { ArrowUpRight } from 'lucide-react' // add to the lucide import
```

Entries:

```tsx
/* --- pay runs ------------------------------------------------------------- */
'new-pay-run': (props) => (
  <NewRunButton
    schedules={(props.schedules as ComponentProps<typeof NewRunButton>['schedules']) ?? []}
    finalPayCandidates={
      (props.finalPayCandidates as ComponentProps<typeof NewRunButton>['finalPayCandidates']) ?? []
    }
    today={str(props, 'today') ?? ''}
  />
),
/**
 * Per-row pay-run action: a plain link to the run wizard (a full page, not
 * a drawer). `href` is rebuilt from the row id exactly like the native
 * template literal; `label` arrives pre-translated from the loader.
 */
'pay-run-row-actions': (props) => (
  <Link
    href={`/payroll/runs/${String(props.id ?? '')}` as never}
    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-teal-300"
    aria-label={str(props, 'label') ?? ''}
    title={str(props, 'label') ?? ''}
  >
    <ArrowUpRight size={15} />
  </Link>
),
```

No drawer widget: rows open the wizard page, and the native page passes no
`drawer` to `RecordListView` — the spec likewise omits it (the slot treats a
missing ref as `undefined`, same as the native default).

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

The sim tenant has ZERO pay schedules, ZERO pay runs, and ZERO `pay_run`
documents, so this page needs fixture rows first (SQL in §3 — please fold
into `scripts/viewspec-fixtures.sql`). After fixtures, the entry:

```js
{
  path: '/payroll/runs',
  // The universal record list over pay_run documents. Two fixture schedules
  // (biweekly + monthly) pin the schedule filter; three fixture runs (draft,
  // calculated, posted) pin the table path including the row-action links to
  // the wizard pages.
  variants: [
    '',
    { query: '?stage=calculated', expect: 'table tbody tr', minMatches: 1 },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

Row-count verification (read-only queries): `select count(*) from pay_runs`
→ 0; `select count(*) from documents where kind='pay_run'` → 0 today. The
`minMatches: 3` counts the three fixture runs from §3. `?stage=calculated`
matches one of them; the stage quick filter (`paramKey: 'stage'`) exists on
the `pay_run` source, and the merged-stage chips replace the raw status
chips (`hideStatusFilter: true`), so no `?status=` variant is proposed.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims the **`…0801–0899` block** (verified free: no `…0008*` id anywhere in
the fixtures file). Two active schedules (biweekly + monthly) and three runs
under the biweekly one: one `draft` (derived stage `calculated` — the variant
above), one `calculated`… — precisely: statuses chosen so the merged-stage
chips show `calculated` twice and `posted` once. Amounts tie exactly: header
`subtotal`/`total` equal the line `amount` sums (untaxed lines).

Period math (must match what `nextPeriodAfter` + the page derive, or the New
button's canonical preview differs from the fixture rows — harmless for the
harness, but keep it sane anyway): biweekly anchor `2026-01-09` (a Friday);
runs cover consecutive 14-day windows ending 2026-02-06, 2026-02-20,
2026-03-06; `pay_date_offset_days = 5` puts pay dates on the following
Wednesday. Monthly schedule anchor `2026-01-31`, no runs yet.

```sql
  -- ---- payroll runs ----------------------------------------------------------
  --
  -- The simulator never runs payroll, so the /payroll/runs list is empty
  -- without these: two schedules (biweekly + monthly) and three runs under
  -- the biweekly one (calculated, calculated, posted). Header totals equal
  -- the line sums; the posted run is closed out of the New button's next
  -- period by a `last_end` of 2026-03-06.
  declare
    v_party uuid;
    v_account uuid;
    v_item uuid;
    v_sched_bi uuid := '00000000-0000-7000-9000-000000000801';
    v_sched_mo uuid := '00000000-0000-7000-9000-000000000802';
  begin
    select id into v_party from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    select id into v_account from accounts
     where org_id = v_org and type in ('income', 'income_other')
       and is_active and not is_summary
     order by number nulls last limit 1;
    select id into v_item from items
     where org_id = v_org and is_active
     order by name limit 1;
    if v_party is null or v_account is null or v_item is null then
      raise notice 'missing party/account/item; skipping payroll fixtures';
      return;
    end if;

    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_default, is_active)
    values
      (v_sched_bi, v_org, 'Biweekly — ViewSpec', 'biweekly', 26,
       date '2026-01-09', 5, true, true),
      (v_sched_mo, v_org, 'Monthly — ViewSpec', 'monthly', 12,
       date '2026-01-31', 0, false, true)
    on conflict (id) do nothing;

    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, currency,
       status, subtotal, tax_total, total, memo, created_at, updated_at)
    values
      ('00000000-0000-7000-9000-000000000811', v_org, 'pay_run', 'PAY-00001',
       v_party, date '2026-02-06', 'USD', 'draft', 5200.0000, 0.0000, 5200.0000,
       'ViewSpec fixture: calculated run', now(), now()),
      ('00000000-0000-7000-9000-000000000812', v_org, 'pay_run', 'PAY-00002',
       v_party, date '2026-02-20', 'USD', 'draft', 5340.0000, 0.0000, 5340.0000,
       'ViewSpec fixture: calculated run', now(), now()),
      ('00000000-0000-7000-9000-000000000813', v_org, 'pay_run', 'PAY-00003',
       v_party, date '2026-03-06', 'USD', 'posted', 5480.0000, 0.0000, 5480.0000,
       'ViewSpec fixture: posted run', now(), now())
    on conflict (id) do nothing;

    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit_price, amount)
    values
      ('00000000-0000-7000-9000-000000000821', v_org,
       '00000000-0000-7000-9000-000000000811', 1, v_item, v_account,
       'ViewSpec fixture line', 1, 5200.0000, 5200.0000),
      ('00000000-0000-7000-9000-000000000822', v_org,
       '00000000-0000-7000-9000-000000000812', 1, v_item, v_account,
       'ViewSpec fixture line', 1, 5340.0000, 5340.0000),
      ('00000000-0000-7000-9000-000000000823', v_org,
       '00000000-0000-7000-9000-000000000813', 1, v_item, v_account,
       'ViewSpec fixture line', 1, 5480.0000, 5480.0000)
    on conflict (id) do nothing;

    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end,
       pay_date, tax_year, run_status, run_type, gross_total, net_total,
       employee_count)
    values
      ('00000000-0000-7000-9000-000000000811', v_org, v_sched_bi,
       date '2026-01-24', date '2026-02-06', date '2026-02-11', 2026,
       'calculated', 'regular', 5200.0000, 5200.0000, 1),
      ('00000000-0000-7000-9000-000000000812', v_org, v_sched_bi,
       date '2026-02-07', date '2026-02-20', date '2026-02-25', 2026,
       'calculated', 'regular', 5340.0000, 5340.0000, 1),
      ('00000000-0000-7000-9000-000000000813', v_org, v_sched_bi,
       date '2026-02-21', date '2026-03-06', date '2026-03-11', 2026,
       'paid', 'regular', 5480.0000, 5480.0000, 1)
    on conflict do nothing;
  end;
```

Caveats for the coordinator (verified as far as read-only queries allow):

- Conflict targets: `documents_pkey` and `document_lines_pkey` are on `id`
  (confirmed from `information_schema`), so those two `on conflict (id)`
  clauses are exact. For `pay_runs` I could NOT confirm a PK — the
  `pay_runs(document_id)` insert above uses a bare `on conflict do nothing`;
  if the table has no suitable unique constraint this must become a
  `where not exists` guard instead. Worth one `\d pay_runs` before folding
  in. (The natural key would be `document_id`, 1:1 with `documents`.)
- `pay_runs` may have NOT NULL columns beyond what the schema listing shows
  defaults for (only `pay_schedules.id` showed a default in my probe). If the
  insert fails on a missing column, add the column with a neutral value —
  but keep the visible columns (`period_*`, `pay_date`, `run_status`,
  totals, `employee_count`) exactly as above, since the list renders them.
- `run_status` values (`calculated`, `paid`) are the engine's own lifecycle
  codes: the list's merged status expression is `case when d.status in
  ('draft','approved') then pr.run_status else d.status end`, so the two
  draft rows surface as `calculated` chips and the posted row as `posted`.
  The `?stage=calculated` variant therefore matches exactly 2 rows — I set
  `minMatches: 1` against it, not 2, to stay robust to stage-filter
  semantics I could not execute here.
- `employee_count: 1` names no real employee (no `pay_run_payments`/
  allocation rows are seeded — the list never reads them). If a future
  wizard-drawer variant needs names, seed one allocation per run; the list
  variants above do not.
- The `payroll` feature flag must resolve on for the SIM org or the page
  404s in both branches (`requireFeatureEnabled`). Same caveat as the
  `orders` flag on the sales-orders page — worth one check if the harness
  404s here.

## 4. What the spec does NOT cover (nothing — full coverage)

- No `sections.tsx`: the page defines no local components. `NewRunButton`
  lives in `web/app/(app)/payroll/_ui/` (outside my owned dir, so I did not
  move it) and the widgets reference it directly.
- The header actions wrapper (`<div className="flex items-center gap-3">`
  around the New button + tabs) is `actionsClassName` on the `pageHeader`
  block — verbatim, including the class string.
- The New button's `canRun` gate is `widget(…, f('canRun'))` on the header
  action and `data.canRun ? newRun : null` on the empty action, matching the
  native `canRun ? <NewRunButton/> : undefined` in both positions.
- The `payroll` feature gate (`requireFeatureEnabled` → `notFound()`) runs
  in the LOADER before any query — both branches 404 identically when the
  feature is off. Nothing travels through the spec for it.
- The row-action `openHref` (`/payroll/runs/<id>`) is rebuilt in the
  `pay-run-row-actions` entry from the row id — byte-identical to the native
  template literal (note: NOT `buildListDrawerHref` — the native link carries
  no `drawerReturn`, since rows open a full page).
- The coordinator's three callouts do not apply: no `<section>` in the native
  markup (header is `PageHeader`, body is the list), no `tabular-nums` on any
  page-owned `<td>` (the `_actions` cell class comes from `RecordListView`
  itself, not the `renderRowActions` closure), and no pager is placed by the
  spec (pagination lives inside the slot).
