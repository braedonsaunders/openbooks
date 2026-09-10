# /admin/roles ViewSpec integration handoff

Page: `web/app/(app)/admin/roles/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. `RoleEditor.tsx` is untouched.

Spec blocks used: `pageHeader` block + `plain-link-button` and `new-role`
header widgets, `search-input` + `filter-chips` in a `grid` row,
`empty-state` / `admin-roles-table` presence pair, `bare` pagination.
Two new widgets (`admin-roles-table`, `new-role`) plus one icon-map
addition — all proposed below, none exist in the registry yet.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed:

```tsx
import { ShieldCheck } from 'lucide-react' // add to the existing lucide-react import
import { AdminRolesTable } from '../../app/(app)/admin/roles/sections'
import { NewRoleButton } from '../../app/(app)/admin/roles/RoleEditor'
```

Entries (place beside the `/* --- org users --- */` admin entries):

```tsx
/**
 * The org role table. Same doctrine as `admin-users-table`: the native
 * page hand-rolls a plain `<table>` (font-mono key column, line-clamped
 * description, tabular-nums counts, type badges, per-row editor buttons)
 * and the spec's table vocabulary cannot name it. Both render paths share
 * the one `AdminRolesTable` component — `page.tsx` imports it for the
 * native branch, this entry for the spec branch. `EditRoleButton` rides
 * inside the table with the same `{ role, subsidiaries }` contract; it is
 * not registered separately.
 */
'admin-roles-table': (props) => (
  <AdminRolesTable
    roles={(props.roles as ComponentProps<typeof AdminRolesTable>['roles']) ?? []}
    subsidiaries={(props.subsidiaries as ComponentProps<typeof AdminRolesTable>['subsidiaries']) ?? null}
    basePath={str(props, 'basePath') ?? '/admin/roles'}
    currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    sort={str(props, 'sort') ?? 'name'}
    dir={str(props, 'dir') === 'desc' ? 'desc' : 'asc'}
    labels={props.labels as ComponentProps<typeof AdminRolesTable>['labels']}
  />
),
/** Header create action. `subsidiaries: null` hides the whole subsidiary-access
 *  section (single-sub orgs); the loader resolves that flag from the session. */
'new-role': (props) => (
  <NewRoleButton
    subsidiaries={(props.subsidiaries as ComponentProps<typeof NewRoleButton>['subsidiaries']) ?? null}
  />
),
```

Empty-state icon addition: the shared `empty-state` widget's closed icon
map has no `shield-check` (the native `EmptyState icon={<ShieldCheck />}`).
Same component, same contract — only the map needs one key:

```tsx
// in the 'empty-state' icons record:
'shield-check': <ShieldCheck />,
```

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org `da472d3a-…`,
harness super-admin `viewspec@sim.test` in the admin role):

```js
{
  path: '/admin/roles',
  // Hand-rolled role table as a widget; header, search, type chips, empty
  // state and pager are ordinary spec. Harness tenant holds 7 built-in
  // roles and 0 custom ones.
  variants: [
    '',
    '?sort=members&dir=desc',
    { query: '?type=custom', expect: 'main h3', minMatches: 1 },
    { query: '?q=zzzznomatch', expect: 'main h3', minMatches: 1 },
  ],
  expect: 'table tbody tr',
  minMatches: 7,
},
```

Row-count verification (read-only queries): `app_roles` in the harness
org → 7 rows, all `is_built_in`, ordered `accountant, admin, approver,
controller, sales_manager, sales_rep, viewer`; permission counts
39/94/22/85/24/19/16; member counts 2/3/0/0/0/0/0. Type counts:
`built_in|7`, no `custom` rows — hence the thead-only `?type=custom`
variant asserting the `noMatchTitle` empty state (`main h3` is the
`EmptyState` title; verified the shared component renders its title in
an `h3`).

GATES check: the page gate is `requirePermission('admin.roles.manage')`
only — no feature flag, no 404 branch. The harness user passes via the
admin role (`*` wildcard covers every check), so the gate is met and the
`minMatches: 7` above is reachable. The subsidiary branch is environment,
not gate: the harness org has exactly 1 active non-elimination
subsidiary, so `subsidiaries` resolves to `null` on both paths and no
subsidiary UI renders in either render.

## 3. Fixture SQL (none)

No fixtures needed: the sim tenant already holds 7 roles covering the
table path, and the empty path is exercised via the `?type=custom` /
`?q=zzzznomatch` variants. No id block is claimed.

## 4. What the spec does NOT cover (nothing — full coverage)

- No `sections.tsx` duplication: `AdminRolesTable` is the single table
  implementation, imported back into `page.tsx` for the native branch.
  `EditRoleButton` keeps its native `{ role, subsidiaries }` contract
  inside the table — one component behind one registry entry.
- The empty-state copy switch (`emptyTitle`/`emptyDescription` vs
  `noMatchTitle`/`noMatchDescription` on `!q && !type`) is resolved in the
  LOADER to `emptyTitle`/`emptyDescription` — presence, not branching.
  The `noDescription` em-dash fallback (`r.description ?? '—'`) travels as
  a label for the same reason.
- The native pager is unwrapped (no `mt-3` spacer), so the spec pager is
  `bare: true` — matching the `admin/users` precedent in the same shell.
- `subsidiaryRestriction: r.subsidiary_restriction ?? { mode: 'all' }`
  mirrors the native default exactly; the drawer consumes it unchanged.
