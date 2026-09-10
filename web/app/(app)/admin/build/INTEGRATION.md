# /admin/build ViewSpec integration handoff

Page: `web/app/(app)/admin/build/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`.

Spec shape mirrors the `/admin` hub conversion exactly (nested `repeat`
over groups/cards in a `bare` layout — the hub owns its own shell): one
new widget, `build-hub-card`, proposed below.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component — the native page and the
spec render path share it; `page.tsx` imports it from `./sections`):

```tsx
import { BuildHubCard } from '../../app/(app)/admin/build/sections'
```

Entry (place beside `admin-hub-card`):

```tsx
/**
 * One Build-hub navigation card. Deliberately NOT `admin-hub-card`: the
 * two hubs' icon sets are disjoint (`tag`, `sliders-horizontal`, `code`
 * exist only here; `users`, `database`, `link`, `mail` and the rest exist
 * only there) and were chosen independently per hub — one shared icon map
 * would let either hub silently render the other's glyphs (the harness
 * caught exactly this species last round). One component behind one
 * registry entry: `BuildHubCard` here, `AdminHubCard` there.
 */
'build-hub-card': (props) => (
  <BuildHubCard
    href={str(props, 'href') ?? '#'}
    iconKey={str(props, 'iconKey') ?? ''}
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    accent={
      (['teal', 'violet', 'amber', 'sky'] as const).find((a) => a === str(props, 'accent')) ??
      'teal'
    }
  />
),
```

The loader makes every native decision as data — permission + feature
gates, `hub.cards.*` title/description resolution, accent key — and the
card classes stay complete literals in `sections.tsx` for Tailwind's
scanner. Nothing (no tone, no accent, no label) is dropped or defaulted
in the widget beyond the two `??` fallbacks, which mirror the
`admin-hub-card` entry's shape for unknown keys.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec`: the harness user
`viewspec@sim.test` is super-admin (every card permission passes via the
`*` wildcard), and the SIM org resolves features to scripts ON (stored
`true`), apps ON (default), apiAccess ON (stored `true`):

```js
{
  path: '/admin/build',
  // The Build hub: nested repeats over permission-filtered groups and
  // cards, in a `bare` layout because the hub owns its own shell. All 4
  // groups and all 8 cards render in the harness tenant.
  variants: [{ query: '', expect: 'section a[href="/records/types"]', minMatches: 1 }],
  expect: 'section a',
  minMatches: 8,
},
```

GATES check (per the /query lesson): the page gates are
`redirect('/login')` when logged out and `redirect('/')` when no group
survives filtering — no feature-flag 404. The harness user is
authenticated and holds every card permission, so all 4 groups (model,
experience, automation, api) and all 8 cards render; the `redirect('/')`
branch is unreachable in the harness tenant. No query variants exist on
this page. No fixture rows are needed — the page reads no tables, only
the session (permissions) and `orgs.settings->'features'`. No fixture id
block is claimed.

## 3. What the spec does NOT cover (nothing — full coverage)

- The loader (`loadBuildHub`) copies the native permission + feature gate
  VERBATIM: `can(authz, c.permission) && (!c.featureKey ||
  featureEnabled(featureState, c.featureKey))`, including the
  `resolvedFeatureState` data-dependent defaults. Both redirects run in
  the loader before any spec.
- `GROUPS` is duplicated between `page.tsx` (native path) and `view.ts`
  (spec path) as message-key constants plus `iconKey` strings, not JSX —
  the same duplication the codebase already accepts between sibling
  conversions. The JSX (Link, icons, accents, ArrowUpRight) exists exactly
  once, in `sections.tsx:BuildHubCard`, imported by both `page.tsx` and
  (via the registry entry above) the spec path.
- The `title={description}` tooltip attr, `aria-hidden` on the arrow, and
  every class string are transcribed verbatim into `sections.tsx`.
- No `sorted`/param logic, no pager, no drawer: the page takes no
  searchParams other than `__viewspec` (forwarded to `ModuleView` as `sp`
  per the branch contract).

## 4. Pre-existing breakage in the merged base (not mine, not touched)

`git merge --no-edit main` fast-forwarded cleanly (my earlier `admin/`,
`reports/`, `admin/roles` work had landed upstream; the conflicting
uncommitted copies in this worktree were stashed). `tsc --noEmit
-p tsconfig.json` is clean across the repo (exit 0).
