# INTEGRATION — `/reports/project-profitability` ViewSpec handoff

Page: the project-profitability report (per-project revenue, COGS, margin
grouped by customer). Files owned by this conversion:

- `web/app/(app)/reports/project-profitability/view.ts` —
  `loadProjectProfitability(sp)` plus `projectProfitabilitySpec(data)`.
- `web/app/(app)/reports/project-profitability/page.tsx` — `__viewspec=1`
  branch added (native branch untouched). No `sections.tsx`: the page defines
  no local component — `ProjectProfitabilityTable` is the shared table
  component that already lives beside the page — so there is nothing composite
  to move.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

Import to add:

```tsx
import { ProjectProfitabilityTable } from '../../app/(app)/reports/project-profitability/ProjectProfitabilityTable'
```

Entry:

```tsx
/**
 * The project-profitability table: customer subtotal rows with expand /
 * collapse, per-project rows linking to the filtered P&L, per-metric
 * report-drill links, and the totals row. Placed whole rather than decomposed
 * into `table` blocks — it owns client-side collapse state (per-customer
 * buttons plus the expand-all/collapse-all section event), interleaved group
 * rows, and its own drill construction. The loader hands over the
 * already-assembled groups, totals and drill targets.
 */
'project-profitability-table': (props) => (
  <ProjectProfitabilityTable
    company={str(props, 'company') ?? ''}
    title={str(props, 'title') ?? ''}
    periodPhrase={str(props, 'periodPhrase') ?? ''}
    currency={str(props, 'currency') ?? ''}
    emptyLabel={str(props, 'emptyLabel') ?? ''}
    columns={(props.columns as string[]) ?? []}
    groups={(props.groups as ComponentProps<typeof ProjectProfitabilityTable>['groups']) ?? []}
    totalLabel={str(props, 'totalLabel') ?? ''}
    totals={props.totals as ComponentProps<typeof ProjectProfitabilityTable>['totals']}
    totalDrills={props.totalDrills as ComponentProps<typeof ProjectProfitabilityTable>['totalDrills']}
  />
),
```

Why not reuse `paper-view`: I diffed it before writing this. `PaperView`
wraps every group in a `<section className="space-y-1.5">` with an optional
h3 header, renders its own empty-state paragraph
(`py-6 text-center text-sm text-slate-400 italic`), and detects negatives only
on raw JS numbers — the profitability values are pre-formatted money strings,
so its red treatment would never fire, while the native table colours them via
`isNegative(value, 'amount' | 'variance_pct')` inside the component. Using
`paper-view` would restyle the page AND silently drop the negative treatment.
The generic `table` block is out for the same reason plus the client-side
collapse state and the chevron toggle buttons. So: one widget, the exact
component both paths already share.

`save-view`, `schedule-report` and `export-menu` already exist in the
registry — no entries needed. `entity-list-view` / `record-list-view` do not
apply (no list, drawer or row actions on this page).

## 2. vocabulary change required before the spec renders at full fidelity (for the coordinator — `packages/viewspec/**`)

The spec wants a `customer` flag on `FilterBarControls`:

```ts
// types.ts — FilterBarControls, beside `dimensions?: boolean`
customer?: boolean
// schema.ts — the strictObject beside `dimensions: z.boolean().optional()`
customer: z.boolean().optional(),
```

Today both are absent: the controls schema is a `strictObject`, so a spec
that names `customer: true` fails validation, and without the flag the
renderer never renders the customer dropdown even though it already binds
`customers` to `ReportFilterBar` (blocks.tsx forwards `block.customers` —
that half of the plumbing exists). The loader in `view.ts` already resolves
and binds `customers` on both filter bars, so the ONE-LINE-each change above
lights up the dropdown with no further edits on this page. Until it lands,
the spec renders everything except the customer picker — the one gap in
section 5.

An Authz/org-id slot is NOT needed: `requirePermission('reports.read')`,
`requireProjectsFeature`, the subsidiary scoping and every query stay in the
loader; only data (strings, booleans, hrefs, drill targets, translated
labels) crosses the spec.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`). GATES checked first: the page
requires `reports.read` (harness super-admin holds `*`) and the `projects`
feature (stored `true` on the sim org — no 404/redirect), plus
`org.base_currency` = USD. Resolved render for the default variant
(`this_fiscal_year`, fiscal start January, business today ~Sep 2026 → window
2026-01-01…2026-12-31; all sim activity is Jan–Mar 2026):

- 14 active projects with P&L activity or approved hours, in 5 customer
  groups, 0 unassigned (every active project has a customer).
- `?customer=1186e699-5da5-466e-8adb-a85ed07a9ee6` (Harborview Development
  LLC) → 1 group / 4 projects — a genuinely different render.
- `?q=zzzznomatch` → 0 groups → the italic empty paragraph — the empty
  branch, not row content.
- `?projects=all` deliberately NOT a variant: 0 inactive projects carry
  activity, so it renders byte-identical to the default — the harness rejects
  non-differing variants as coverage.

Row shape: 5 group subtotal rows + 14 project rows + 1 totals row = 20
`table tbody tr`.

```js
{
  path: '/reports/project-profitability',
  // Whole-table widget (collapse state + interleaved subtotals stay in the
  // component); complementary filter bars behind loader flags (sections
  // control is data-driven). Default: 5 customer groups / 14 projects /
  // totals = 20 body rows. Customer variant narrows to 1 group / 4
  // projects; the search variant pins the empty branch.
  variants: [
    '',
    { query: '?customer=1186e699-5da5-466e-8adb-a85ed07a9ee6', expect: 'table tbody tr', minMatches: 6 },
    { query: '?q=zzzznomatch', expect: 'main p', minMatches: 1 },
  ],
  expect: 'table tbody tr',
  minMatches: 20,
},
```

## 4. Fixture SQL (none)

No fixtures needed: the sim tenant already satisfies every gate (projects
feature on, USD base currency, 14 active projects with activity across 5
customers, 707 project-tagged journal lines). No id block is claimed.

## 5. What the spec does NOT cover (one gap — the customer picker)

- Everything else is loader work copied verbatim from `page.tsx`: the
  `reports.read` gate, `requireProjectsFeature`, period resolution with the
  org id, subsidiary scoping, the five-way query fan-out, the base-currency
  throw, the P&L href and ledger/time drill construction (including
  `profitSigned` and `activeProjectsOnly`), the customer grouping with the
  `noCustomer` fallback, and the expand/collapse labels.
- Message keys used by the loader (`projectProfitability.*`,
  `trialBalance.totals`, `pnl.dateRange`, `hub.title`) are all already
  consumed by the native page — verified by grep against
  `web/messages/en/reports.json`; none invented.
- `page.tsx` native branch is untouched below the `__viewspec` branch.
- GAP: the customer dropdown in the filter bar (native
  `controls={{ customer: true }}` + `customers={customers}`). The loader
  binds `customers` and the renderer forwards them, but `FilterBarControls`
  has no `customer` flag so the spec cannot turn the control on — see section
  2 for the exact two-line coordinator change that closes it.
