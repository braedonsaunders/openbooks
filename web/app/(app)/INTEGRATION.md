# `/` ViewSpec integration handoff

Page: `web/app/(app)/` — owner files are `view.ts` (new) and the
`__viewspec` branch + imports in `page.tsx` (this handoff's edit). No
`sections.tsx`: the page needs no composite cells (see §4).

This page renders the same home dashboard as `/dashboard`
(`web/app/(app)/dashboard/`). Both paths share the `dashboard-header` /
`dashboard-grid` registry entries and the `page-container` frame — nothing
new is needed in `widgets.tsx`, and the two specs differ only in loader
names (`loadRootDashboard` / `rootDashboardSpec` vs `loadDashboard` /
`dashboardSpec`).

Spec widgets used: `dashboard-header`, `dashboard-grid` (both already in
the registry — `web/components/viewspec/widgets.tsx` lines ~1232-1240).
`page-container` is an existing frame (`blocks.tsx` `FRAME_REGISTRY`);
`grid` is core vocabulary.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

No new entries. The spec uses the two entries the `/dashboard` conversion
already landed:

- `'dashboard-header': (props) => <DashboardHeader greeting={str(props, 'greeting') ?? ''} />`
- `'dashboard-grid': () => <DashboardGridSlot />`

EXACT prop shapes (wired verbatim already; repeated here so the mapping is
auditable against this spec):

- `dashboard-header`: `props.greeting: string` — the loader resolves the
  time-of-day greeting (locale + first name) over the
  `dashboard.greeting.*` keys; the Customize link
  (`/dashboard/customize`, label `dashboard.header.customize`) lives
  inside `DashboardHeader` (`_dashboard-header.tsx`), not in props. No
  label prop exists on the component, so none is passed.
- `dashboard-grid`: no props at all. The `DashboardGridSlot` re-derives
  the layout, the `canSeeWidget` filter, the stale-node prune, the tile
  nodes and the bound `saveQuickActions` action from the session — the
  accounts-page slot pattern (loader owns data, host owns capabilities).

No new shared slot file is needed: `DashboardGridSlot`
(`web/components/viewspec/dashboard-grid-slot.tsx`) already exists.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`; harness user
`viewspec@sim.test` `01a08426-0962-74c7-a086-e1609c589dcb`, super-admin
with the `admin` role assignment, no `user_dashboard_layouts` row):

```js
{
  path: '/',
  // `/` renders the same home dashboard as `/dashboard` (same greeting,
  // same slot, same PageContainer wrapper), so the pin is the same:
  // the Customize link that only renders once the dashboard tiles settle.
  // The harness user is super-admin with the `admin` role assignment and
  // no user_dashboard_layouts row: layout resolution falls through to the
  // role_dashboard_layouts `admin` row (8-widget admin default — 4 KPI
  // cards, personal-actions, list-pending-approvals, personal-in-progress,
  // list-recent-entries). canSeeWidget passes all 8 with `*`; the prune
  // check drops nothing (no app:/UUID ids in the admin default).
  variants: [''],
  expect: 'main a[href="/dashboard/customize"]',
  minMatches: 1,
},
```

Row-count verification (read-only queries, `set app.bypass_rls='on'`):

- `role_assignments → app_roles` for the harness user on the harness org
  → `admin` (verified this session).
- `role_dashboard_layouts where org_id=<harness org>` → 7 rows; the
  `admin` row's `layout->'widgets'` lists the 8-widget admin default
  (`kpi-cash-balance`, `kpi-open-receivables`, `kpi-open-payables`,
  `kpi-pending-approvals`, `personal-actions`, `list-pending-approvals`,
  `personal-in-progress`, `list-recent-entries` — verified this session).
- `user_dashboard_layouts where org_id=<harness org> and
  user_id=<harness user>` → 0 rows, so the role default wins.
- `journal_entries where status in ('posted','reversed')` → 430 rows, so
  `list-recent-entries` renders 5 rows (`limit 5`); `flow_gates where
  status='pending'` → 3 rows, so both `kpi-pending-approvals` and
  `list-pending-approvals` are non-empty.
- `documents where status='draft' and created_by=<harness user>` → 0, so
  `personal-in-progress` renders its empty state on both paths (identical
  markup — the same `CardShell` + `EmptyRow` — the customize-link `expect`
  above is the positive proof the page rendered and not the loading
  screen).

Conformance caveats for the coordinator's run (same as `/dashboard` —
same component, same slot):

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
branch the harness user reaches on `/` — 430 posted entries (recent list
non-empty), 3 pending gates (approval KPI + list non-empty), zero
user-authored drafts (in-progress empty state on both paths). I read the
allocation table at the top of `scripts/viewspec-fixtures.sql` and grepped
the whole file (`grep -o` for every `…NNNN-NNNN` block header and every
`00000000-0000-7000-9000-00000000NNNN` id in use): proposing no fixture
ids, so no collision is possible. If the coordinator wants the
in-progress NON-empty branch covered too, the fresh block to claim is
`…1401-1499` (no `1401`–`1499` ids appear anywhere in the file; neighbours
`…1301-1399` CRM prospects and `…1801-1899` payroll are taken): insert one
`draft` document with `created_by` = the harness user
(`01a08426-0962-74c7-a086-e1609c589dcb`), following the payroll-block
pattern (`v_user` lookup by email, `on conflict (id) do nothing`).

## 4. What the spec does NOT cover (nothing on this page is dropped)

- No `sections.tsx`: the page defines one local helper (`buildGreeting`,
  a pure function) — already moved to `dashboard/_greeting.ts` by the
  `/dashboard` conversion and imported into both `page.tsx` (native
  branch) and `view.ts` (loader), so both render paths share one
  implementation. No second copy exists.
- `DashboardHeader` and `DashboardGrid` (via `DashboardGridSlot`) are
  shared components, so the spec's widgets reference them directly.
- The `saveQuickActions` server action is bound in the slot (same
  function reference the native page passes) and never named or
  constructed in the spec.
- `DashboardGrid`'s client-only behaviour (drag/resize, viewport
  breakpoints, palette, save/reset toolbar in edit mode) is out of scope:
  the view page renders `mode="view"` only. The `/dashboard/customize`
  route is a different page and is NOT converted here.
- The signed-out branch (`authz` null → loader returns `null`, page
  returns `null`) is identical to native. (The brief's branch template
  assumes a loader that always returns data; here the loader returns
  `RootDashboardData | null` and the branch guards it — the `/dashboard`
  precedent.)
- Message keys used: `dashboard.greeting.morning/afternoon/evening` —
  all pre-existing in `web/messages/en/dashboard.json` (the loader calls
  only `t('greeting.*')`; `dashboard.header.customize` resolves inside
  `DashboardHeader` itself). No invented keys.
- `generateMetadata` does not exist on this route (unlike
  `dashboard/page.tsx`), so there is nothing to keep in sync.

## 5. Pre-existing state of the base (not mine, not touched)

- `git merge --no-edit main` at session start reported
  `Already up to date.` — the worktree branched from a fresh main.
- The `/dashboard` conversion (commits `79e78fe92`, `94b52d15d`) already
  landed the `dashboard-header` / `dashboard-grid` registry entries, the
  `DashboardGridSlot`, the `/dashboard` conformance entry, and the
  `_greeting.ts` shared helper. This conversion reuses all of them and
  adds no shared-file edits; the only files touched are the three
  page-owned files (`view.ts`, `page.tsx`, this file).
- Proposed shared-file edits for the coordinator: none beyond the
  conformance entry in §2. No `packages/viewspec` vocabulary was needed.
