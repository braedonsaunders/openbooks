# INTEGRATION — `/reports/custom/run/[id]` ViewSpec handoff

Page: the saved-query report runner (entity-query chrome — header back to
the hub, filter-bar row with Export, the already-run paper, optional pager).
Files owned by this conversion:

- `web/app/(app)/reports/custom/run/[id]/view.ts` —
  `loadReportRun(id, sp)` plus `reportRunSpec(data)`.
- `web/app/(app)/reports/custom/run/[id]/page.tsx` — `__viewspec=1`
  branch added (native branch untouched). No `sections.tsx`: the page defines
  no local component — `ResultView`, `ReportPaper`, `ReportFilterBar`,
  `ScheduleReportButton`, `ExportMenu` and `SaveViewButton` are all shared
  components living beside or above the page — so there is nothing composite
  to move.

Spec widgets used: `pageHeader` + `filter-bar` blocks, `paper` + `text`
blocks, `pagination` block, `result-view` / `schedule-report` / `save-view` /
`export-menu` / `link-button` widgets (all five exist in the registry — no
new widget entries needed).

## 1. WIDGET_REGISTRY entries (none — all exist)

No new imports, no new entries. Exact prop shapes the spec passes each
existing widget (flat props in every case — verified against the entries in
`web/components/viewspec/widgets.tsx`):

- `link-button` (Edit): `{ href: string, label: string, variant: 'outline',
  size: 'sm' }` + `when: f('canCreate')` on the ref. The entry reads
  `str(props,'href'|'label'|'variant'|'size')` and renders
  `<Button asChild variant size><Link href>` — the native
  `<Button variant="outline" size="sm" asChild><Link …>{tc('actions.edit')}
  </Link></Button>` verbatim.
- `schedule-report`: `{ definitionId: string, historyHref: string }`. The
  entry renders `<ScheduleReportButton definitionId historyHref>` (no
  `statementParams` — the native page passes none either).
- `save-view`: `{}` — the entry takes no props (`() => <SaveViewButton />`),
  same as the native bare `<SaveViewButton />`.
- `export-menu`: `{ baseHref: string }`. The entry renders
  `<ExportMenu baseHref>` — the native
  `<ExportMenu baseHref={…/export${exportQs}} />` verbatim (no `kind`, no
  `params`).
- `result-view`: flat `{ company: string, title: string,
  description: string | null, result: ReportRunResult,
  drillTarget: ReportDrillTarget }`. The entry passes all five straight into
  `<ResultView company title description result drillTarget>` — the native
  `<ResultView company title description={periodPhrase ?? displayDescription}
  result drillTarget={{ kind:'custom', source:'definition', id, label }} />`
  verbatim.

An Authz/org-id slot is NOT needed: `requirePermission('reports.read')`,
`canRunReportEntity` (permission + Features gate), the org-scoped definition
load, period resolution, the payroll lookup and the read-only execution all
stay in the loader; only data (strings, booleans, hrefs, the executed result,
drill targets) crosses the spec.

## 2. Vocabulary change required before the spec renders at full fidelity (for the coordinator — `packages/viewspec/**` + `web/components/viewspec/blocks.tsx`)

The spec wants an `extraPeriods` binding on the filter-bar block:

```ts
// types.ts — FilterBarBlock, beside `periodPresets?: FieldRef`
extraPeriods?: FieldRef
// schema.ts — filterBarBlock strictObject, beside `periodPresets`
extraPeriods: fieldRefSchema.optional(),
// blocks.tsx — filter-bar case, beside the periodPresets bind
extraPeriods={bind<ComponentProps<typeof ReportFilterBar>['extraPeriods']>(block.extraPeriods)}
```

Today all three are absent (plus the schema is a `strictObject`, so naming
the field fails validation): the loader already resolves `extraPeriods` and
carries it on `ReportRunData`, but the spec cannot bind it — so the spec
renders everything except the pay-period optgroup on payroll reports. The
native `ReportFilterBar` already accepts `extraPeriods?: ExtraPeriodOption[]`
and renders the optgroup itself, so the three-line change above lights it up
with no further edits on this page. Until it lands, the gap is section 5,
first bullet.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`; harness super-admin holds `*`; all
sim features on, so the payroll/inventory entity gates pass). GATES checked
first: the page requires `reports.read`, then `canRunReportEntity` (entity
permission + Features switch — same gate as `/api/reports/run`), and 404s on
a non-uuid id, an other-org id, or a denied entity. Statement-type
definitions `redirect()` to their statement page in BOTH branches (shared
loader code path — not a variant).

Resolved render windows (fiscal start January, business today ~Sep 2026):
default `this_fiscal_year` → 2026-01-01…2026-12-31; all sim activity is
Jan–Mar 2026. Row counts below come from executing the real path
(`loadReportDefinition` → `applyBuiltInUrlFilters` → `resolvePeriod` →
`applyPeriodOverride` → `executeReport`) inside the sim tenant — not from
sampling tables:

- `gl-activity-by-account-fy` (`01a083e6-dce6-7158-aeab-dce836642ee9`,
  summarize over `ledger_lines` on `posting_date`, NOT paginated):
  default → summary Groups=42, 1 group / 42 rows; `?period=custom&from=
  2026-01-01&to=2026-03-31` → 41 groups/rows — a genuinely different render
  (one account's activity falls outside Q1); `?period=last_fiscal_year` →
  0 rows → the italic `noRows` empty paragraph — the empty branch.
- `payroll-register` (`01a083e6-dce7-764d-9852-830f12f7e0ca`, rows over
  `pay_stubs` on `pay_date`, payroll category → 3 pay-period extraPeriods
  PAY-00001…PAY-00003 resolved): default → 1 group / 2 rows. Exercises the
  payroll extraPeriods loader path; the optgroup itself renders only after
  the §2 vocabulary change.
- `lot-recall` (entity `inventory_lot_movements`, the ONLY catalog entity
  with `pagination`, `defaultPeriodField: null` → `noPeriodField` bar):
  default → `pageInfo={totalRows:0}` → pager `total=0`. Exercises the
  paginated path AND the no-period filter bar. NOT a variant here: the
  inventory-entity gate needs the `inventory` feature (on for sim) and the
  assertion would be `main` — weak. Instead the pager presence is covered by
  asserting the pager element on the gl-activity default render is ABSENT…
  no — simpler: no lot-recall variant. The `hasPageInfo` flag logic is
  identical to the close-page `bare` pager precedent; the harness cannot
  reach a paged entity with rows in sim data (0 lot movements), so a pager
  variant would compare two identical empty pagers. Omitted deliberately.

```js
{
  path: '/reports/custom/run/01a083e6-dce6-7158-aeab-dce836642ee9',
  // Saved-query runner: complementary filter bars behind loader flags
  // (period control is plan-data-driven), ResultView paper placed whole,
  // error branch as paper + verbatim paragraph, no pager (entity not
  // paginated). Default: 1 group / 42 rows. Custom-Q1 variant narrows to
  // 41 rows (genuinely different render); last-FY variant pins the empty
  // branch (0 rows → noRows paragraph).
  variants: [
    '',
    { query: '?period=custom&from=2026-01-01&to=2026-03-31', expect: 'table tbody tr', minMatches: 41 },
    { query: '?period=last_fiscal_year', expect: 'main p', minMatches: 1 },
  ],
  expect: 'table tbody tr',
  minMatches: 42,
},
{
  path: '/reports/custom/run/01a083e6-dce7-764d-9852-830f12f7e0ca',
  // Payroll path: loader resolves 3 pay-period extraPeriods (the optgroup
  // itself needs the §2 vocabulary change); 1 group / 2 rows.
  variants: [''],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Expect selectors: the paper tables are native `<table>`s inside
`[data-report-paper]`, so `table tbody tr` counts result rows (PaperView
renders one `<section class="space-y-1.5">` per group — no `repeat.unwrapped`
needed since the whole result stays inside the `result-view` widget). The
empty branch renders `<p className="py-6 text-center text-sm text-slate-400
italic">{emptyLabel}</p>` — `main p` with minMatches 1.

## 4. Fixture SQL (none)

No fixtures needed and no id block claimed: every gate passes on sim data
(`reports.read` via super-admin, `payroll`/`inventory` features on), and
every variant above resolves to real rows (or a real empty) from the
simulator's own ledger/payroll data. The error branch
(`?period=last_fiscal_year` on the expense report is the EMPTY branch, not
the error branch) needs no fixture either: the loader's `hasError` flag is
wired to `!result`, and an invalid built-in param (e.g. `?accountType=zzz`
on a uuid/date-bound built-in… none of the conformance definitions bind URL
filters, so no error variant is proposed — the flag pair is still covered
because `hasResult`/`hasError` are strict complements and the harness
renders the default + empty variants).

## 5. What the spec does NOT cover (one gap — the pay-period optgroup)

- GAP: the pay-period optgroup in the period picker on payroll reports
  (native `extraPeriods={extraPeriods}` on `ReportFilterBar`). The loader
  resolves all 3 sim pay runs into `ExtraPeriodOption`s; the filter-bar
  block cannot bind them — see section 2 for the exact three-line
  coordinator change that closes it. Everything else about the payroll path
  (category detection, window-per-pay-date, period override) is loader work
  and renders identically.
- Everything else is loader work copied verbatim from `page.tsx`: the
  `reports.read` gate, the `canCreate` computation, the `isUuid` / missing-
  definition / statement-redirect / missing-query / entity gates (redirect
  and notFound shared with the native branch through the loader), the
  pagination normalization (`clamp` bounds verbatim, `page`/`perPage` URL
  keys), the built-in localization fallback, `applyBuiltInUrlFilters`,
  `parseReportQuery` + `resolvePeriod` + `applyPeriodOverride`, the
  `pnl.dateRange` phrase, the export-param mirroring (omitting
  `page`/`perPage`/`format`), the read-only `executeReport` /
  `executeReportPage` fan-out with the missing-`pageInfo` throw, and
  `orgBranding`.
- Message keys used by the loader (`reports.hub.title`,
  `reports.pnl.dateRange`, `common.actions.edit`) are all already consumed
  by the native page — verified by grep against
  `web/messages/en/reports.json` and `web/messages/en/common.json`; none
  invented. (The unused `reports.custom` namespace import was dropped —
  the native page imports `tk` but never calls it.)
- The native pager (`<Pagination basePath currentParams={sp} …>` with NO
  `mt-3` wrapper) is `pagination({…, bare: true })` — the `currentParams`
  always comes from the render-time searchParams in the block renderer, so
  there is nothing to bind.
- `page.tsx` native branch is untouched below the `__viewspec` branch.
- The `delivery/` subroute is a different page and out of scope (owned by
  whoever converts `run/[id]/delivery`).
