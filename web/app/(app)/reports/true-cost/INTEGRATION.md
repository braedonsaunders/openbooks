# INTEGRATION — `/reports/true-cost` ViewSpec handoff

Page: the true-cost (overhead burden) report — period filter bar plus a
five-group `PaperView` paper. Files owned by this conversion:

- `web/app/(app)/reports/true-cost/view.ts` —
  `loadTrueCost(sp)` plus `trueCostSpec(data)`.
- `web/app/(app)/reports/true-cost/page.tsx` — `__viewspec=1`
  branch added (native branch untouched). No `sections.tsx`: the page defines
  no local component — `PaperView`, `ReportFilterBar`, `ExportMenu`,
  `SaveViewButton`, `ScheduleReportButton` are all shared components that
  already live beside/below the page — so there is nothing composite to move.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

No new entries needed. I diffed before writing this:

- `paper-view` already exists and already renders exactly this `PaperView`
  (`company`, `currency`, `emptyLabel`, `data`) — the same widget the
  trial-balance page places for its generic tabular report.
- `link-button` already exists (solid Button + Link, closed icon map, no
  icon unless `iconKey` names one) and matches the native recovery-plan
  action byte for byte: `<Button variant="outline" size="sm" asChild>` with
  a bare `<Link>` child, no icon. The spec passes
  `{ href: '/analytics/true-cost/planner', label: <tc
  panels.recoveryPlan>, variant: 'outline', size: 'sm' }` with no `iconKey`.
  This is the same widget the budget page uses for its manage action.
- `schedule-report`, `save-view`, `export-menu` already exist.

`entity-list-view` / `record-list-view` do not apply (no list, drawer or row
actions on this page).

### EXACT prop shapes for every widget the spec references

The coordinator wires these verbatim — literal props only, plus field refs
where marked. No guessed wrappers.

1. `link-button` — `{ href: string; label: string; variant: 'outline'; size: 'sm' }`
   (no `iconKey`; no `when` — always rendered). Renders the native
   recovery-plan planner link.
2. `schedule-report` — `{ definitionId: string; statementParams: Record<string, string> }`
   with `when: f('hasScheduleDef')`. The loader resolves `definitionId` to
   `''` when the anchor is absent and raises `hasScheduleDef` from
   `Boolean(definitionId)`, mirroring the native
   `{definitionId ? <ScheduleReportButton/> : null}`.
3. `save-view` — `{}` (no props).
4. `export-menu` — `{ kind: 'true-cost'; params: Record<string, string | undefined> }`.
   `params` is the raw search-params object, exactly as the native page passes
   `params={sp}`.
5. `paper-view` — `{ company: string; currency: string; emptyLabel: string; data: unknown }`
   where `data` is the `ExportData` shape plus `periodPhrase`
   (`{ ...data, periodPhrase: data.dateRangeLabel }`), exactly as the native
   page spreads it.

## 2. Vocabulary change required (none)

No `packages/viewspec/**` change is needed. The spec uses only closed
vocabulary that already exists: `page`, `pageHeader`, `filterBar`
(`{ period: true }` — the flag exists), and whole-component `widget` /
`widgetBlock` placements. An Authz/org-id slot is NOT needed:
`requirePermission('reports.read')`, `requireProjectsFeature`, the period
resolution with the org id, and every query stay in the loader; only data
(strings, booleans, hrefs, translated labels, the assembled paper shape)
crosses the spec.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`). GATES checked first: the page
requires `reports.read` (harness super-admin holds `*`) and the `projects`
feature (stored `true` on the sim org — no redirect), plus
`org.base_currency` = USD. Resolved render for the default variant
(`this_fiscal_year`, fiscal start January, business today Sep 2026 → window
2026-01-01…2026-12-31; all sim expense/time activity is Jan–Mar 2026):

- Expense lines in the window (posted/reversed, primary book, non-summary
  expense accounts, nonzero): 56 lines across 8 distinct accounts and
  months 2026-01/02/03.
- No `burden`/`cost_pool` `account_groups` rows exist for the sim org, so
  `groups` is empty, `byAccount` is empty, and all 8 nonzero window accounts
  land in `unassigned`. No non-billable labour cost exists (all 4,903 hrs
  in the window are billable, `nonbill_cost = 0`), so no native time
  category is added and no custom categories exist on the default profile —
  `categories` is EMPTY.
- `monthly` covers the union of burden months and hours months: the burden
  series only accumulates inside the per-account loop for CLASSIFIED
  accounts, and with zero classified accounts `monthBurden` stays empty, so
  `monthly` = the 3 hours months (2026-01/02/03).
- Paper groups (always 5, titles fixed): overhead-categories (0 rows →
  italic empty paragraph), rate-matrix (0 rows → empty), rate-by-department
  (0 rows → empty; sim has a single department, "Field operations", but its
  time entries carry a NULL `department_id` so `departmentsBase` is EMPTY),
  composite-trend (3 month rows), unassigned-accounts (8 rows). Summary
  strip: 3 KPI items (always rendered).
- Data-row totals: 0 + 0 + 0 + 3 + 8 = 11 `table tbody tr`, plus 3 italic
  empty paragraphs (`main p`) from the three empty groups.
- `?period=2025_calendar_year` → a genuinely different render: zero 2025
  activity, so every group renders the italic empty paragraph (`main p`)
  and zero tables.
- `report_definitions` holds a `true-cost` slug for the sim org, so the
  schedule button renders on the default variant (the `hasScheduleDef`
  presence branch is exercised).

```js
{
  path: '/reports/true-cost',
  // Body is one PaperView placed whole (summary strip + five section
  // tables stay in the component); the planner link reuses `link-button`.
  // Default (2026 fiscal window, no burden groups configured): 0 + 0 + 0
  // + 3 + 8 = 11 body rows, plus 3 italic empty paragraphs from the three
  // empty groups. The 2025 variant pins the all-empty branch (five italic
  // empty paragraphs).
  variants: [
    '',
    { query: '?period=2025_calendar_year', expect: 'main p', minMatches: 5 },
  ],
  expect: 'table tbody tr',
  minMatches: 11,
},
```

## 4. Fixture SQL (none)

No fixtures needed and **no id block is claimed**: the allocation table at
the top of `scripts/viewspec-fixtures.sql` was checked and the whole file
grepped for `true-cost`/`trueCost` (no hits) — but the sim tenant already
satisfies every gate (projects feature on, USD base currency, 56 expense
lines, 4,903 billable hours, a `true-cost` schedule anchor), so no seeding
is required. I deliberately claim no block so a later page that truly needs
one cannot collide with a speculative reservation.

## 5. What the spec does NOT cover (no gaps)

- Everything permission-, time- and money-dependent stays in the loader,
  copied verbatim from `page.tsx`: the `reports.read` gate,
  `requireProjectsFeature`, period resolution with the org id, the
  `trueCostExportData` query (including its internal subsidiary scoping via
  `requireReportAuthz`), the branding query, the `true-cost` schedule
  anchor, and the `{ ...data, periodPhrase: data.dateRangeLabel }` rename.
- Message keys used by the loader (`hub.title`, `generalLedger.empty`,
  `analytics.trueCost` → `title`, `panels.recoveryPlan`) are all already
  consumed by the native page or present in `web/messages/en/*.json` —
  verified by grep; none invented.
- `page.tsx` native branch is untouched below the `__viewspec` branch.
