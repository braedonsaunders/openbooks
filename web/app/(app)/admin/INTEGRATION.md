# /admin ViewSpec integration handoff

Page: `web/app/(app)/admin/` — owner files are `view.ts`, `sections.tsx`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.

Spec blocks used: `grid` (three nested, one with `as: 'section'`),
`pageHeader`, `heading`, `repeat` (nested, both `unwrapped`). One new
widget: `admin-hub-card` (proposed below).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component — the native page and the
spec render path share it; `page.tsx` imports it from `./sections`):

```tsx
import { AdminHubCard } from '../../app/(app)/admin/sections'
```

Entry (place next to the `/* --- org users --- */` admin entries):

```tsx
/**
 * One admin-hub navigation card: a Next Link composing a per-card lucide
 * icon, an accent class set, and an ArrowUpRight hover arrow. The icon and
 * accent are `iconKey`/`accent` lookups resolved here, so the spec carries
 * only data — including the full Tailwind class strings, which must stay
 * complete literals or the scanner purges them.
 */
'admin-hub-card': (props) => (
  <AdminHubCard
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

Why a widget and not spec blocks: the card is a single anchor composing a
Next Link, a per-card lucide icon and accent-scoped Tailwind classes — the
same "link over a summary line" composite-cell case the brief assigns to
`sections.tsx`, lifted to a repeat item. The `heading` block covers the
group `<h2>`; no other new vocabulary is needed.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec`: the harness user
`viewspec@sim.test` is super-admin (all permissions pass), and the SIM org
`da472d3a-…` resolves features to scripts ON (stored `true`), flows ON
(default), apps ON (default), apiAccess ON (stored `true`), queryConsole
OFF (default) — so the platform group renders 5 of its 6 cards:

```js
{
  path: '/admin',
  // The admin hub: 4 permission-gated groups, 15 cards for the harness
  // tenant (super-admin; queryConsole off so the query card is absent).
  // No query params exist on this page, so a single default render covers
  // every branch the harness tenant can reach.
  variants: [''],
  expect: 'section a[href="/admin/users"]',
  minMatches: 15,
},
```

GATES check: the empty-groups `redirect('/')` is unreachable in the harness
tenant (super-admin always holds at least one card permission), so no
404-variant applies. No fixture rows are needed — the page reads no tables,
only the session (permissions) and `orgs.settings->'features'`. No fixture
id block is claimed.

## 3. What the spec does NOT cover (nothing — full coverage)

- The loader (`loadAdminHub`) copies the native permission + feature gate
  VERBATIM: `can(authz, c.permission) && (!c.featureKey ||
  featureEnabled(featureState, c.featureKey))`, including the `resolvedFeatureState`
  data-dependent defaults. The empty-groups `redirect('/')` and the
  logged-out `redirect('/login')` run in the loader before any spec — both
  redirects are preserved, not re-expressed.
- `GROUPS` is duplicated between `page.tsx` (native path) and `view.ts`
  (spec path) as message-key constants plus `iconKey` strings, not JSX —
  the same duplication the codebase already accepts between sibling
  conversions. The JSX (Link, icons, accents, ArrowUpRight) exists exactly
  once, in `sections.tsx:AdminHubCard`, imported by both `page.tsx` and (via
  the registry entry above) the spec path.
- The native `ACCENTS`/`cn`/icon imports are gone from `page.tsx`; both
  paths render through `AdminHubCard`, so the DOM cannot drift.
- `title={description}` on the anchor, `aria-hidden` on the arrow icon, and
  every class string are transcribed verbatim into `sections.tsx` — including
  the `cn()` merge order (`accent.border` appended after the base card
  classes, `accent.chip` after the icon-span base). `cn` (tailwind-merge)
  keeps order-independent duplicates identical, so this is byte-safe.
- No `sorted`/param logic, no pager, no drawer: the page takes no
  searchParams other than `__viewspec` (forwarded to `ModuleView` as `sp`
  per the branch contract).

## 4. Pre-existing breakage in the merged base (not mine, not touched)

`git merge --no-edit main` reported "Already up to date" — no conflicts.
`tsc --noEmit -p tsconfig.json` is clean across the repo (exit 0), including
the previously reported `CustomizationTabs` breakage — that file now
typechecks (another agent's conversion has since landed).
