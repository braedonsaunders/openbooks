# /dashboard ViewSpec integration handoff

Page: `web/app/(app)/dashboard/` — owner files are `view.ts`,
`_greeting.ts` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. No `sections.tsx`: the page needs no composite cells (see §4).

Spec widgets used: `dashboard-header`, `dashboard-grid-view` (both
proposed below — neither exists in the registry yet). `page-container`
is an existing frame (`blocks.tsx` `FRAME_REGISTRY`); `grid` is core
vocabulary.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed (all already exist as components):

```tsx
import { DashboardGrid } from '../../app/(app)/dashboard/_dashboard-grid'
import { DashboardHeader } from '../../app/(app)/dashboard/_dashboard-header'
import type { DashboardGridData } from '../../app/(app)/dashboard/view'
```

Entries:

```tsx
/* --- dashboard --------------------------------------------------------- */
/**
 * The home-dashboard header: the time-of-day greeting plus the Customize
 * link. The loader resolves the greeting string (locale + first name) and
 * the link label; the entry passes them straight through, so the message
 * keys (`dashboard.greeting.*`, `dashboard.header.customize`) never travel
 * through the spec.
 */
'dashboard-header': (props) => (
  <DashboardHeader greeting={str(props, 'greeting') ?? ''} />
),
/**
 * The home-dashboard tile grid. Two halves of this page cannot be expressed
 * as declarative blocks, so both ride through this ONE host widget — the
 * same doctrine as the `record-list-view` slot:
 *
 * - The responsive grid is a live `react-grid-layout` canvas: drag/resize
 *   callbacks, ResizeObserver measurement, viewport media queries, per-tile
 *   remove buttons. Interactive client state, not data.
 * - Every tile node is a client component: `WidgetCard` reads the `useMoney`
 *   context, `QuickActions` holds editor state and a bound `saveQuickActions`
 *   server action, `CardTile` self-fetches over POST, `AppWidgetCard` reads
 *   translations. A spec carries no component references and no capability
 *   objects, so the widget receives pre-rendered nodes and an already-bound
 *   save action — the accounts-page slot pattern (loader owns data, host
 *   owns capabilities).
 *
 * EXACT prop shape — the coordinator must wire it verbatim; a guessed
 * wrapper breaks the render:
 *
 *   props.grid: {
 *     initialLayout: {
 *       widgets: Array<{ id: string; x: number; y: number; w: number; h: number }>
 *       quickActions?: Array<{ id: string; label?: string; labelKey?: string;
 *                              href: string; iconKey: string; tone: string }>
 *     }
 *     nodes: Record<string, ReactNode>   // pre-rendered tile nodes, keyed by widget id
 *     role: 'admin' | 'controller' | 'accountant' | 'approver' | 'viewer'
 *     quickActionsSaveAction: (input: QuickAction[]) => Promise<{ ok: true } | { ok: false; error?: string }>
 *     hiddenQuickActionIds: string[]      // curated ids suppressed by feature flags
 *   }
 *
 * The widget renders the grid in VIEW mode only — the native page passes
 * `mode="view"` — with `saveRedirectHref` left at its `'/'` default:
 *
 *   <DashboardGrid
 *     initialLayout={grid.initialLayout}
 *     nodes={grid.nodes}
 *     role={grid.role}
 *     mode="view"
 *     quickActionsSaveAction={grid.quickActionsSaveAction}
 *     hiddenQuickActionIds={grid.hiddenQuickActionIds}
 *   />
 */
'dashboard-grid-view': (props) => {
  const grid = props.grid as DashboardGridData
  return (
    <DashboardGrid
      initialLayout={grid.initialLayout}
      nodes={grid.nodes}
      role={grid.role}
      mode="view"
      quickActionsSaveAction={grid.quickActionsSaveAction}
      hiddenQuickActionIds={grid.hiddenQuickActionIds}
    />
  )
},
```

Note on the header entry: `DashboardHeader` takes only `{ greeting }` —
the Customize link (`/dashboard/customize`, label
`dashboard.header.customize`) renders inside the component, not from props.
The entry resolves the greeting server-side (the loader already did) and
passes nothing else. No label prop exists on the component, so none is
proposed here.

No new shared slot file is needed: unlike `RecordListSlot` these widgets
re-render existing components with loader-owned props only — no org id,
user id or permission decision is re-derived, because nothing in the props
is a capability. (`nodes` are opaque `ReactNode`s, not data that names a
tenant; `quickActionsSaveAction` is bound server-side in the loader, the
same function reference the native page passes.)

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`; harness user
`viewspec@sim.test`, super-admin with the `admin` role assignment, no
`user_dashboard_layouts` row):

```js
{
  path: '/dashboard',
  // The harness user is super-admin (permissions `*`, unrestricted
  // subsidiaries) with the `admin` role assignment and no
  // user_dashboard_layouts row: loadAssignedRoleDefault returns the
  // role_dashboard_layouts `admin` row (the 8-widget admin default — 4 KPI
  // cards, personal-actions, list-pending-approvals, personal-in-progress,
  // list-recent-entries). canSeeWidget passes all 8 with `*`; the prune
  // check drops nothing (no app:/UUID ids in the admin default). Expected
  // tiles: 4 metric links ("/journal", "/ar", "/ap", "/approvals?tab=all")
  // + 2 list cards with rows + in-progress card + quick-actions grid.
  variants: [''],
  expect: 'main a[href="/dashboard/customize"]',
  minMatches: 1,
},
```

Row-count verification (read-only queries, `set app.bypass_rls='on'`):

- `role_dashboard_layouts where org_id=<harness org>` → 7 rows; the
  `admin` row carries the 8-widget admin default, and the harness user's
  first role key is `admin`, so `loadAssignedRoleDefault` returns it
  (`sourceKey: 'role:admin'`). No `user_dashboard_layouts` row for the
  harness user → the role default wins.
- `journal_entries where status in ('posted','reversed')` → 429 rows, so
  `list-recent-entries` renders 5 rows (`limit 5`); `flow_gates where
  status='pending'` → 3 rows, so both `kpi-pending-approvals` and
  `list-pending-approvals` are non-empty.
- `insight_cards where status='published'` → 1 row (`Revenue by month`),
  but no layout references a UUID id → no card nodes either way.
- `apps where status='installed' and active_version_id is not null` → 3
  rows (`viewspec-demo`, `viewspec-noversion`, `viewspec-nodesc`), but the
  admin role default names no `app:` ids → no app nodes either way.
- `documents where status='draft' and created_by=<harness user>` → 0, so
  `personal-in-progress` renders its empty state on both paths (identical
  markup — the same `CardShell` + `EmptyRow` — but a count of zero tiles
  either way; the customize-link `expect` above is the positive proof the
  page rendered and not the loading screen).

Conformance caveats for the coordinator's run:

- The greeting is time-of-day dependent (`new Date().getHours()`): native
  and spec renders a minute apart across an 11:59→12:00 boundary would
  differ. Same flake exists natively on every render; re-run if it bites.
- `DashboardGrid` measures its container with ResizeObserver and renders
  `react-grid-layout` client-side (`ssr: false`): the harness must wait
  for the settled grid (the `renderSettled` + `expect` wait already does
  this), and the tile order inside `main` is grid-position order on both
  paths because both render the same component with the same props.
- `QuickActions` uses `framer-motion` entrance animations and
  `ActionTile` stagger delays: the harness's pixel tolerance must absorb
  sub-pixel animation differences, or the comparison must wait for
  animations to settle. Structural comparison is exact regardless.

## 3. Fixture claim (fresh block — nothing to add)

No new fixtures needed: the simulated tenant already exercises every
dashboard branch the harness user reaches — 429 posted entries (recent
list non-empty), 3 pending gates (approval KPI + list non-empty), zero
user-authored drafts (in-progress empty state on both paths). I verified
the allocation table at the top of `scripts/viewspec-fixtures.sql` and
grepped the whole file: proposing no fixture ids, so no collision is
possible. If the coordinator wants the in-progress NON-empty branch
covered too, the fresh block to claim is `…1201-1299` (no `1201`–`1299`
ids appear anywhere in the file; neighbours `…1101-1199` apps and
`…1801-1899` payroll are taken): insert one `draft` `vendor_bill`
document with `created_by` = the harness user
(`01a08426-0962-74c7-a086-e1609c589dcb`),
`document_number` e.g. `BILL-VIEWSPEC-1`, following the payroll-block
pattern (`v_user` lookup by email, `on conflict (id) do nothing`).

## 4. What the spec does NOT cover (nothing on this page is dropped)

- No `sections.tsx`: the page defines one local helper (`buildGreeting`,
  a pure function) — MOVED to `_greeting.ts` and imported back into both
  `page.tsx` (native branch) and `view.ts` (loader), so both render paths
  share one implementation. No second copy exists.
- `DashboardHeader` and `DashboardGrid` are shared components, so the
  widgets reference them directly.
- The `saveQuickActions` server action is bound in the loader (same
  function reference the native page passes) and handed to the widget as
  an opaque prop — never named or constructed in the spec.
- `DashboardGrid`'s client-only behaviour (drag/resize, viewport
  breakpoints, palette, save/reset toolbar in edit mode) is out of scope:
  the view page renders `mode="view"` only. The `/dashboard/customize`
  route is a different page and is NOT converted here.
- The signed-out branch (`authz` null → `null`) is loader logic returning
  `null`, and the page returns `null` — identical to native. (The brief's
  branch template assumes a loader that always returns data; here the
  loader returns `DashboardData | null` and the branch guards it.)
- Message keys used: `dashboard.greeting.morning/afternoon/evening`,
  `dashboard.header.customize` — all pre-existing in
  `web/messages/en/dashboard.json` (verified by read; no invented keys).

## 5. Pre-existing state of the base (not mine, not touched)

- `git merge --no-edit main` reported `Already up to date.` — the worktree
  was already on a fresh main.
- `web/node_modules` was absent in this worktree, so `tsc` was
  unavailable; I ran `pnpm install --prefer-offline --ignore-scripts`
  (warm store, 3.7s) and removed the installer-created `pnpm-lock.yaml`
  afterwards — `git status` shows only my four files.
