# /payroll/retro ViewSpec integration handoff

Page: `web/app/(app)/payroll/retro/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.
No `sections.tsx`: nothing is moved or duplicated — `RetroWorkspace`
stays where it is and both render paths import the same component.

Spec blocks used: `pageHeader` (exists) + `module-home-tabs` (exists in
the registry) + `retro-workspace` (proposed below — does not exist yet).

## Why one workspace widget

This page is a fully client-interactive workspace, not a server-rendered
list. Everything below lives in `RetroWorkspace.tsx` client state or
bound fetch calls, and none of it is spec vocabulary:

- the schedule select (default `schedules[0]`) and the pay-date input
  (default `useBusinessToday()`), both component state — not URL params;
- the propose POST (`/api/payroll/retro`, action `propose`) with toast
  feedback, and the create POST (action `create`) that routes into the
  pay-run wizard;
- the exclusion checkbox set (`excluded` source-pay-run document ids);
- both `PagedTable`s with client-side search and paging (the review
  table at 15/page, the per-period buckets table at 10/page);
- the per-period detail drawer, which opens from a clicked row object
  (there is no `?period=` flyout param — the drawer is not
  URL-addressable).

The tables cannot be decomposed into `table` blocks either: their cells
are conditional pairs (payable-vs-em-dash Paid / Should-have-paid /
Already-settled cells, the outcome-toned Difference cell, the four-way
outcome badge — success / destructive / warning / secondary — the
payable-only checkbox cell, null-hours-vs-value Hours cells) plus
multi-element cells (the period cell wraps start–end in a
`whitespace-nowrap` span; the delta cell wraps money in a toned span;
the drawer reason rows stack a badge over detail text). A spec cannot
express any of that, and splitting the tables out would put one
component's state in two places. This is the same call the parallel-run
page made (`parallel-run-workspace` places `ParallelRunView` whole):
the workspace stays whole.

Money, dates and counts are deliberately NOT formatted in the loader.
The native component formats them client-side — `useMoney` is
browser-locale via `next-intl` + `MoneyProvider`, and period/pay dates
are rendered raw (`row.candidate.periodStart`, no slicing). Per the
trap list, the loader passes the canonical store values through and
the component does what it always did. Formatting them server-side
would double-format and change the bytes.

The permission gate IS load-bearing and is reproduced: `payroll.read`
via `requirePermission`, the `payroll` feature gate (404 when
disabled), the `payroll.run` flag for the create-run action, and the
module tabs via `groupTabs` (which filters on the org's feature
state). The schedule list itself is visibility-filtered —
`scopedRetroSchedules` applies `payrollVisibleScheduleFilter(gate)`,
so a restricted caller sees fewer schedules (a disclosure, not just
a filter) — and the loader reproduces it verbatim by calling the same
function. The `Authz`/org id never cross the spec boundary — the
loader consumes them, the widget receives only rows + the boolean.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (component already exists in my owned dir):

```tsx
import { RetroWorkspace } from '../../app/(app)/payroll/retro/RetroWorkspace'
```

Entry (place in the payroll group, beside `parallel-run-workspace`):

```tsx
/**
 * Retroactive-pay workspace. Placed whole rather than decomposed: it owns
 * schedule/pay-date picker state, propose/create fetch mutations, the
 * exclusion checkbox set, both PagedTables, and the detail drawer. The
 * loader hands over the scoped schedule rows untouched; money stays
 * canonical because the component formats client-side (browser locale).
 */
'retro-workspace': (props) => (
  <RetroWorkspace
    schedules={props.schedules as ComponentProps<typeof RetroWorkspace>['schedules']}
    canRun={props.canRun === true}
  />
),
```

**Exact prop shape the spec passes** (two sibling keys, matching the
component's destructured signature `{ schedules, canRun }`):

| prop | type | source |
|---|---|---|
| `schedules` | `{ id: string, name: string }[]` | `scopedRetroSchedules(authz)` verbatim (active schedules with committed history, visibility-filtered by the caller's subsidiary scope, ordered by name) |
| `canRun` | `boolean` | `can(authz, 'payroll.run')` |

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/payroll/retro',
  // One workspace widget: the schedule/pay-date controls plus the idle
  // copy ("Pick a schedule and a pay date…"). The proposal tables, the
  // exceptions panel, the summary tiles and the detail drawer are all
  // post-POST client state over fetch (propose), not URL-addressable, so
  // there is no drawer or results variant.
  variants: [''],
  expect: '#retro-schedule option',
  minMatches: 1,
},
```

Verified against `openbooks_sim_viewspec` (RLS bypassed; harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` = `SIM · Summit Ridge Construction`):

- `payroll` feature on for the harness org (`settings->'features'->'payroll'` → `true`) — the feature gate passes.
- `scopedRetroSchedules` real rows: **1 row** (`Biweekly — ViewSpec`,
  `…1801`) — only the biweekly schedule has a committed run
  (`PAY-00003`, `committed`); the monthly schedule (`…1802`) has none,
  so the EXISTS clause excludes it. The schedule `<Select>` therefore
  renders 1 `<option>`, hence `minMatches: 1` on
  `#retro-schedule option`.
- `expect: '#retro-schedule option'` rather than a table selector:
  the default render is the idle branch (no proposal yet — `proposal`
  is component state, null until the operator clicks "Find retroactive
  pay"), so there is NO table on first paint. A `tbody tr` assertion
  would match zero rows in both renders and prove nothing; the
  schedule option pins the one piece of real database content the
  default render carries.
- Gates: same as the already-green `/payroll/runs` and
  `/payroll/parallel-run` entries (harness user `viewspec@sim.test`
  holds the `admin` role per the `/payroll` INTEGRATION.md precedent,
  whose permission set covers `payroll.read` + `payroll.run`; feature
  flag verified `true` above).
- Visibility filtering: `scopedRetroSchedules` applies
  `payrollVisibleScheduleFilter(gate)`. The harness user is
  unrestricted (`allowedSubsidiaryIds` null → `sql``` no-op branch),
  so the full 1-row result renders — the loader calls the same
  function, exactly as page.tsx does.

## 3. Fixture SQL (for the coordinator — `scripts/viewspec-fixtures.sql`)

None needed. This page reuses the `…1801–1899` payroll schedules-and-runs
block the `/payroll/runs` conversion already claimed (the `…1801`
biweekly schedule with its `committed` PAY-00003 is exactly the one
row `scopedRetroSchedules` returns). I claim no new id block; the
`…1830–1839` parallel-run block is untouched, and a grep for
`00000000184`–`00000000189` across the fixtures file, all
`INTEGRATION.md` files and the conformance registry returns zero hits
— but I need none of them. ON CONFLICT DO NOTHING has nothing of mine
to collide with.

## 4. GATES checked (not just row counts)

- Native page gates: `requirePermission('payroll.read')` (redirects when
  absent — loader reproduces verbatim), `requireFeatureEnabled(orgId,
  'payroll')` (404 when disabled — loader reproduces verbatim).
  Harness user holds `admin`, feature is on: both pass.
- Visibility filtering: `scopedRetroSchedules` filters
  hidden-subsidiary schedules through `allowedSubsidiaryIds`. The
  harness user holds the admin role (unrestricted), so the no-op
  branch runs — the loader passes the same `authz` through, exactly
  as page.tsx does.
- New/empty branches: with no committed schedule the native page shows
  the controls with an empty select + the same idle copy (the `find`
  button is disabled). With fixtures it shows 1 schedule option + the
  same idle copy. The default variant pins the populated branch; the
  post-propose branches (tiles, exceptions panel, review table,
  buckets drawer) are fetch-driven client state in both renders by
  construction.

## 5. What could not be expressed (and why)

1. **The workspace itself.** `RetroWorkspace` — picker state, the
   propose/create fetch mutations, the exclusion set, `PagedTable`
   search/paging, the detail drawer — is placed whole through
   `retro-workspace` (§1). No new ViewSpec vocabulary needed; nothing
   is re-proposed beyond the single registry entry.
2. **No results variant.** The proposal tables render only after the
   operator clicks "Find retroactive pay" (a POST to
   `/api/payroll/retro`), so no query string can pin them for the
   harness. Both renders share the component, so the results code is
   identical by construction.
3. **No drawer variant.** The detail drawer opens from a clicked row
   object over component state, not from a URL param, so no query
   string can pin it for the harness. Both renders share the
   component, so the drawer code is identical by construction.
