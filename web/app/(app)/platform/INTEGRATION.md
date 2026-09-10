# /platform ViewSpec integration handoff

Page: `web/app/(app)/platform/` — owner files are `view.ts`, `sections.tsx`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.

Spec blocks used: `frame('page-container')`, `grid` (two nested), `pageHeader`,
`repeat` (`unwrapped`, at PAGE level so props use plain `{ $ }` refs, not
`rootRef`). Two new widgets: `platform-notice` and `platform-tile`
(proposed below).

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed (both already exist as components — the native page and
the spec render path share them; `page.tsx` imports them from `./sections`):

```tsx
import { PlatformNotice, PlatformTile } from '../../app/(app)/platform/sections'
```

Entries (place next to the hub/launcher entries, e.g. after `reports-hub`):

```tsx
/**
 * The static amber platform-workspace banner: a ShieldCheck icon with
 * amber-scoped Tailwind classes. Carries no data, so the entry takes no
 * props — the same doctrine as the query console's prop-less entry.
 */
'platform-notice': () => <PlatformNotice />,
/**
 * One platform-hub navigation tile: a Next Link composing a per-tile lucide
 * icon, a loader-formatted stat, and a loader-built detail line. The icon
 * is an `iconKey` lookup resolved here, so the spec carries only data —
 * all class strings stay complete literals for Tailwind's scanner.
 *
 * Flat props: href, iconKey, title, description, stat, detail — every
 * value a string (NOT a single `tile` object).
 */
'platform-tile': (props) => (
  <PlatformTile
    href={str(props, 'href') ?? '#'}
    iconKey={
      (['building-2', 'users', 'key-round', 'mail'] as const).find(
        (k) => k === str(props, 'iconKey'),
      ) ?? 'building-2'
    }
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    stat={str(props, 'stat') ?? ''}
    detail={str(props, 'detail') ?? ''}
  />
),
```

Why widgets and not spec blocks: the tile is a single anchor composing a
Next Link, a per-tile lucide icon and amber-scoped Tailwind classes — the
same "link over a summary line" composite case the brief assigns to
`sections.tsx`, lifted to a repeat item (like `admin-hub-card`). The notice
is a static icon-plus-classes composite the grid vocabulary cannot name.

Registry helper used: `str` (already defined in `widgets.tsx`); no new
helper needed. No slot: the loader calls `platformSummary()` directly, which
runs its own `withBypassContext` — no Authz, org id, or user id crosses the
spec boundary.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec`
(`set app.bypass_rls='on'`; the harness counts with RLS on through the
super-admin bypass path — same query, same rows):

```
organizations=2 productionOrganizations=2 environments=0
activeUsers=6 superAdmins=1 activeGrants=0 failedEmails=1
```

```js
{
  path: '/platform',
  // The platform hub: a static notice plus 4 summary tiles whose stats come
  // from one platformSummary() bypass query (2 orgs, 6 active users, 0
  // grants, 1 failed email). The harness user must be super-admin; without
  // one the layout gate redirects and BOTH renders would agree about the
  // wrong page (same caveat as the /platform/* entries). The page takes no
  // query params, so a single default render covers every branch the
  // harness tenant can reach.
  variants: [{ query: '', expect: 'main a[href^="/platform/"]', minMatches: 4 }],
  expect: 'main a[href="/platform/organizations"]',
  minMatches: 1,
},
```

GATES check: the only gate is `requireSuperAdmin()` in `layout.tsx`, which
runs BEFORE either render path (the layout wraps both) — it is not
re-expressed in the spec, and `loadPlatformHub` does not re-check it. The
redirects (`/login` when logged out, `/` when not super-admin) are
unreachable in the harness tenant (super-admin session), so no redirect
variant applies. No fixture rows are needed — the page reads aggregate
counts that already exist in the sim tenant. No fixture id block is
claimed.

Two branches the harness tenant cannot distinguish (documented, not
covered): the environments split (`2 production · 0 non-production` — the
sim tenant has no non-production orgs, so the `non-production` detail path
renders but never with a nonzero count) and the super-admin plural (the
sim tenant has exactly 1, so the `superAdmins === 1` singular path is the
only one exercised). Both strings are built verbatim in the loader, so the
bytes cannot drift — only the counts can, and those are data.

## 3. What the spec does NOT cover (nothing — full coverage)

- The loader (`loadPlatformHub`) calls `platformSummary()` VERBATIM — the
  same single bypass query, no permission filtering (the layout gate already
  ran). Stat formatting (`.toLocaleString()`), the production/non-production
  detail, the super-admin plural, and the two static detail labels are copied
  verbatim from `page.tsx`'s `stat`/`detail` closures into the loader.
- `tiles` is duplicated between `page.tsx` (native path) and `view.ts`
  (spec path) as href/`iconKey`/title/description constants plus the
  stat/detail builders — the same duplication the codebase already accepts
  between sibling conversions (cf. `admin/view.ts` GROUPS). The JSX (Link,
  Card, icons, amber classes) exists exactly once, in
  `sections.tsx:PlatformTile`/`PlatformNotice`, imported by both `page.tsx`
  and (via the registry entries above) the spec path.
- Class strings are transcribed verbatim into `sections.tsx` — including
  the `Card interactive` + `hover:border-amber-300` merge (Card's `cn`
  keeps order-independent duplicates identical, so this is byte-safe) and
  the `tabular-nums` on the stat span (a widget cell gets none
  automatically, so it stays explicit in the component).
- The `space-y-6` wrapper div and the `PageContainer` shell: the wrapper is
  a `grid('space-y-6', …)` at PAGE level (a native `<div>`, so no `as`
  needed); the shell is the existing `page-container` frame the coordinator
  registers — the same arrangement as the analytics hub. `layout: 'bare'`
  so `ModuleView` concatenates header (empty) and body without nesting a
  second `ListPageLayout`.
- No `sorted`/param logic, no pager, no drawer, no message keys: every
  string on this page is a hardcoded English literal in both paths (the
  native page uses no `t()`), and the page takes no searchParams other than
  `__viewspec` (forwarded to `ModuleView` as `sp` per the branch contract).
- The `repeat` sits at PAGE level (one grid above it), so tile props use
  plain `{ $: '…' }` item refs — `$root` exists inside the repeat but is
  not needed here; no `rootRef` appears.

## 4. Pre-existing state of the merged base (not mine, not touched)

`git merge --no-edit main` reported "Already up to date" — no conflicts.
Typecheck setup per the task: symlinked `node_modules` →
`/Users/braedonsaunders/Documents/openbooks/node_modules` (root and `web/`);
no `npm install` run.
