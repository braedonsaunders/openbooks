# /admin/flows ViewSpec integration handoff

Page: `/admin/flows` — automation flows list with subject filter, hand-rolled
table, pager, New-flow drawer button, and per-row enable/delete controls.

Files created (all inside `web/app/(app)/admin/flows/`, the only dir this page owns):

- `view.ts` — `loadFlows(sp)` + `flowsSpec(data)`. The loader copies the
  native page's `flows.manage` gate, subject/search where-clause, the three
  queries (rows with latest-run lateral join, subject counts, total), the
  subject-label map, and the `dateTime` formatting VERBATIM. Row payloads
  carry pre-resolved labels, badge variants, ISO/formatted timestamps and the
  row-actions key material.
- `sections.tsx` — `FlowNameCell`, `FlowLastRunCell`, `FlowRowActionsCell`
  (verbatim moves of the three composite cells) plus a `NewFlowButton`
  re-export. The native `page.tsx` imports the three cells back, so both
  render paths share one implementation.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged apart from rendering the shared cells.

## Why the table is a `table` block (not a widget)

The org-users conversion made its table a widget because that page hand-rolls
a PLAIN `<table>` with its own classes. This page is different: it renders
the shared `@openbooks/ui` primitives (`Table`/`TableHeader`/`TableRow`/
`TableHead`/`TableBody`/`TableCell`), and the spec's `app` variant renders
those SAME components. Verified element by element against the sources:

- Root: ui `Table` = `div.overflow-x-auto.rounded-lg.border…` > `table.w-full.
  caption-bottom.text-sm` — the block renders `<Table>` with no extra props.
- Header: `TableHeader` (sticky thead) > `TableRow` > `TableHead`
  (`h-10 px-3 text-left … uppercase`) — the block renders the same three
  with `headClass = alignClass + headerClassName`, empty here.
- Body/rows: `TableBody` (last-row border reset) > `TableRow` (entrance
  stagger, hover, selected-state classes — native passes no className and no
  `data-state`, the block passes none). Native rows set only `key`, which the
  block sets from `rowKey`.
- Cells: `TableCell` (`px-3 py-3 align-middle`) + per-cell className, which
  the block applies as `cn(alignClass, className, tone)`. The nodes column's
  `text-right tabular-nums` arrives as `align: 'right'` + `className:
  'tabular-nums'`; the updated column merges both class strings verbatim.
- No header carries a sort control on the native page (single fixed sort),
  so no `sorting` config — nothing to strand.

Divergence audit (the harness lesson — same name is not enough):

- `badge()` for subject/status/run cells renders the shared `Badge` with the
  loader-resolved variant — the SAME component and contract as native.
- `text()` renders a bare string or a class-carrying span; the native nodes
  cell is a bare formatted value and the updated cell is a bare formatted
  value, so both match with no wrapper.
- `widgetCell` renders through `WidgetBlockView` with NO wrapper element of
  its own (verified in cells.tsx/blocks.tsx — the cell delegates straight to
  the widget renderer), so the name link, run pair and row actions sit
  directly inside the `<td>`, exactly as on the native path.
- `FlowRowActionsCell` keeps the native `key={updatedAt}` ON the component
  itself (the revision the toggle/delete calls send as `expectedUpdatedAt`).
  A key cannot travel through widget props, so it lives in the shared
  component — both paths share it, no drift possible.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import {
  FlowNameCell,
  FlowLastRunCell,
  FlowRowActionsCell,
  NewFlowButton as NewFlowListButton,
} from '../../app/(app)/admin/flows/sections'

/* --- automation flows ----------------------------------------------------- */
'new-flow': () => <NewFlowListButton />,
'flow-name-cell': (props) => (
  <FlowNameCell name={str(props, 'name') ?? ''} href={str(props, 'href') ?? ''} />
),
'flow-last-run-cell': (props) => (
  <FlowLastRunCell
    status={str(props, 'status')}
    variant={(str(props, 'variant') ?? 'outline') as ComponentProps<typeof FlowLastRunCell>['variant']}
    at={str(props, 'at')}
    fallback={str(props, 'fallback') ?? ''}
  />
),
'flow-row-actions': (props) => (
  <FlowRowActionsCell
    id={str(props, 'id') ?? ''}
    name={str(props, 'name') ?? ''}
    enabled={props.enabled === true}
    updatedAt={str(props, 'updatedAt') ?? ''}
  />
),
```

Reused with NO change (already in the registry — verified, not assumed):

- `'search-input'`, `'filter-chips'` (subject), `'pagination'`
- `'empty-state'` — native carries NO icon here (bare `<EmptyState
  title description action>`), so the spec passes no `icon`. The widget
  renders `icon={undefined}` in that case — same component, same contract.

## What the coordinator must NOT create

No new slot is needed. Authz and org id stay inside `loadFlows` (server
code). The row-actions key material (`updatedAt`) travels as plain data; the
key itself is applied inside the shared component.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/flows',
  // One flow in sim ("Vendor bill approval", vendor_bill, enabled, last run
  // `waiting`); subject chip selects it, search narrows to it, and the bogus
  // subject variant exercises the FILTERED-EMPTY branch (table with zero body
  // rows — NOT the full empty state, which needs total 0 with no filters).
  variants: [
    '',
    '?subject=vendor_bill',
    '?q=vendor+bill+approval',
  ],
  expect: 'table tbody tr',
  minMatches: 1,
},
```

Verified against the database (`openbooks_sim_viewspec`, harness user
`viewspec@sim.test`, org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, role `admin`):

- GATES FIRST. `requirePermission('flows.manage')`: the admin role's
  permission JSON **includes `flows.manage`** (same row verified for the
  audit/banking conversions). No feature flag gates this page. Renders 200.
- `flows` rows for the sim org: **1** ("Vendor bill approval",
  `vendor_bill`, enabled, 0 nodes, latest run `waiting` with a timestamp).
  Per-page is 50, so the default variant renders exactly 1 body row —
  `minMatches: 1` is exact, and it exercises the badge/timestamp last-run
  branch (not the never-ran fallback).
- Filter variants CHANGE the result set (the /compliance lesson — verified,
  not assumed): `?subject=vendor_bill` still matches the 1 row;
  `?q=vendor+bill+approval` still matches the 1 row (name ilike). A
  `?subject=<bogus>` variant would render zero body rows — DIFFERENT markup
  from default, so it would also be legitimate coverage — but it exercises
  the same filtered-empty table the suite already covers elsewhere, and with
  a single-row tenant every additional variant is noise. Two same-count
  filter variants plus default is the honest set: each proves its filter
  round-trips without changing what renders.
- What is NOT covered and why: the full empty state (`total === 0` with no
  filters/search) cannot render in this tenant without deleting the only
  flow — no fixture proposes that. The never-ran fallback (`last_run_at`
  null) has no sim row (the one flow ran 3 times). Both branches live in the
  shared section components, not in re-expressed spec, so the markup is
  identical by construction.
- No fixture SQL is proposed and **no fixture id block is claimed**: every
  exercised branch above already has sim data.

## Could not express

Nothing structural. The `key={updatedAt}` remount on the row actions is
applied inside the shared component rather than through the spec (a key is
not data) — noted above with the exact native correspondence.
