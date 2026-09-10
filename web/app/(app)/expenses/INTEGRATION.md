# /expenses ViewSpec integration handoff

Page: `web/app/(app)/expenses/` — owner files are `view.ts` (+ this file).
The spec in `view.ts` needs ONE registry entry the coordinator owns
(`web/components/viewspec/widgets.tsx`). No `sections.tsx`: the dashboard has
no per-row composite cell to share — its tables live inside the cockpit.

## Design

This follows the ar-cockpit archetype (`web/app/(app)/ar/view.ts`), not a
list page. The body is one client cockpit — KPI vitals, client-state sub-tabs,
the echarts trend, the approval queue, the top-spender and category tables,
the drill drawer — and it stays whole behind ONE widget:
`expenses-dashboard`, rendering the shared `ExpensesDashboard` over the exact
`ExpensesDashboardData` the native page already passes as
`<ExpensesDashboard data={data} />`. Decomposing live echarts options,
`useMoney` compact formatting, `useState` tab/drill state and the
fetch-on-open `DrillDrawer` into generic blocks would reimplement the
component badly rather than compose it.

What the spec DOES express (the part that matters for tenant overrides):
the header (title/description from `expenses.dashboard.*`, the New button
gated on `expenses.create`, the purchasing strip tabs) and the placement of
the cockpit inside `ListPageLayout` with
`bodyClassName: 'flex h-full min-h-0 flex-col'` (transcribed verbatim from
`page.tsx`'s `ListPageLayout className`).

The header actions wrapper is byte-exact by construction: the native page
renders `<div className="flex items-center gap-3">` around
`[NewExpenseButton?, ModuleHomeTabs]`; the spec sets
`actionsClassName: 'flex items-center gap-3'` and the page-header renderer
emits the same `<div>` when `actionsClassName` is present. (The
`page-header` renderer wraps in a plain `WidgetSlot` fragment when it is
absent, which would drop the div — hence the explicit class.)

## 1. `WIDGET_REGISTRY` entry (coordinator adds)

```tsx
/* --- expenses cockpit ----------------------------------------------------- */
'expenses-dashboard': (props) => (
  <ExpensesDashboard
    data={props.data as ComponentProps<typeof ExpensesDashboard>['data']}
  />
),
```

- Needs import: `ExpensesDashboard` from
  `../../app/(app)/expenses/ExpensesDashboard`.
- `data` is the loader's `ExpensesDashboardData` verbatim — pipeline counts
  and canonical money strings, summary, topSpenders, categories,
  monthlyTrends, queue, period. All client-safe (strings/numbers/arrays);
  the drill drawer's per-entity fetch rides the session cookie inside the
  shared component, so no user id, org id or Authz crosses the spec.
- `new-expense` and `module-home-tabs` already exist in the registry (landed
  by the `/expenses/reports` conversion). Note the existing `new-expense`
  entry is prop-less (`() => <NewExpenseButton />` — the button owns its own
  labels via `useTranslations`); the spec's header action for it carries no
  props, only the `canCreate` presence flag. The parenthetical in the reports
  INTEGRATION.md about a label/creatingLabel variant was a proposal only —
  the landed registry entry takes no props, and this spec matches that.
- The header `pageHeader` title/description bind `f('title')` /
  `f('description')` = `t('dashboard.title')` / `t('dashboard.description')`.
  Every other `t('...')` in the cockpit stays inside the shared client
  component via `useTranslations('expenses.dashboard')` — no invented keys.
  Verified: `dashboard.title`, `dashboard.description`, `dashboard.tabs.*`,
  `dashboard.windowHint`, `dashboard.vitals.*`, `dashboard.panels.*`,
  `dashboard.table.*`, `dashboard.series.*` all exist in
  `web/messages/en/expenses.json`, and the loader uses only the two keys the
  native page used (`dashboard.title`, `dashboard.description`).

## 2. Proposed conformance registry entry

Verified against `openbooks_sim_viewspec` (bypass RLS). The harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` holds **30 `expense_report`**
documents, all `posted`, spanning posting dates 2026-01-02 → 2026-03-30.
The loader window is trailing-12-months from `businessToday` (= org business
date; DB `current_date` is 2026-09-10, so the window is ~2025-10-01 →
2026-09-10 with prior from ~2024-10-01):

- pipeline: draft/pending/approved all 0 (queue empty → the native
  `panels.queueEmpty` branch); posted-month count/total 0 (no posted rows in
  September 2026).
- topSpenders: 12 employees (`having sum(d.total) > 0` over the full
  prior-from window), all rows posted.
- categories: 1 account (the simulator posts expense-report lines against a
  single expense account; 46 journal lines join).
- monthlyTrends: 3 months with rows (2026-01: 29 lines, 2026-02: 122,
  2026-03: 133). Months with no rows are absent from the series (the query
  has no generate_series), so the X axis carries exactly these 3 labels.
- `highSpenderCount` / `categoryIncreaseTotal` resolve over whatever the
  current/prior split is at harness time; they are text inside tiles, not
  structural branches, so they cannot break the selectors below.

The dashboard has no query params (the loader takes `sp` only for the branch
signature; searchParams flow to `ModuleView` for widget use). Variants
therefore pin content branches; the second variant opens the Breakdown tab —
except the sub-tabs are `useState` client state, so a query string cannot
select them. A single default render covers what the harness can reach:

```js
{
  path: '/expenses',
  // Expenses cockpit: header (New button + purchasing strip tabs) over the
  // dashboard widget. No query params drive this page, so one render covers
  // it: 5 vitals tiles + trend panel + queue panel (+ its queueEmpty copy,
  // the queue is empty in fixtures) + categories panel = 8+ h3/panel
  // headings. The Breakdown sub-view (spender/category tables) is useState
  // client state — unreachable by query string, covered by the shared
  // component's own render path, not the harness.
  variants: [
    '',
  ],
  expect: 'section h3',
  minMatches: 3,
},
```

- `section h3` matches the three overview `Panel` titles (Monthly trend,
  Approval queue, Category breakdown). `minMatches: 3` is exact today (3
  overview panels) and robust: the Breakdown tab's 2 panels never render
  server-side, and the vitals strip uses `p`, not headings.
- No fixture rows needed: 30 posted reports + 46 category lines already
  exist in the harness org. No fixture id block claimed.
- The DrillDrawer renders null with no drill target (both paths), so it
  contributes no markup to either side.

## 3. What could not be expressed

1. **The cockpit interior.** Vitals tiles (`KpiCard`), the Overview /
   Breakdown sub-tabs, the echarts trend (`Chart` with computed series and a
   `valueFormatter` closure), the queue list (Next `Link` rows with
   `STATUS_VARIANT` badge mapping and a `statusLabel` helper closing over
   `common` translations), the spender/category tables (click-to-drill rows,
   `pct1` formatting, conditional change classes), and the `DrillDrawer`
   (fetch-on-open, `useState` view/search/page) all stay inside the shared
   `ExpensesDashboard` component. A spec cannot carry closures, component
   references, or client state — this is the same interiority the AR cockpit
   documents in its handoff, and the honest division: the widget renders the
   one shared implementation, so the two paths cannot drift.
2. **No new vocabulary needed.** `pageHeader` (+ `actionsClassName`), `grid`
   is unused here (the cockpit owns its own flex column internally, the same
   way `AnalyticsHub` owns its shell), and the single `widgetBlock` place the
   whole page. No `packages/viewspec` changes proposed. No `sections.tsx`:
   every cell the page renders lives inside the cockpit component.
