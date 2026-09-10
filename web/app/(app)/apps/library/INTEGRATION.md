# /apps/library ViewSpec integration handoff

Page: `/apps/library` — the marketplace browser (searchable, paginated grid
of listing cards with per-card install/update buttons, one empty/resultless
note branch, bare pager; gates `apps.manage`, layout adds the `apps`
feature gate for the whole segment).

Files created (all inside `web/app/(app)/apps/library/`, the only dir this
page owns):

- `view.ts` — `loadAppsLibrary(sp)` + `appsLibrarySpec(data)`. The loader
  copies the native page's query, permission and formatting logic verbatim
  (the `apps.manage` gate, `listListings` search + pagination,
  `listApps(orgId)` + `installedByKey` lookup, `installed?.version ===
  listing.version` currency check, `t('version', …)` lines,
  `description || t('noDescription')` fallback, `params.q ? …noResults… :
  …empty…` copy selection, 12-per-page). The word "manage" does double
  duty: `requirePermission` gates the page, `canManage` gates the docs
  button. They coincide (both key off `apps.manage`), so one boolean serves
  both — and it stays a loader-resolved field, never a literal, so the spec
  never hardcodes a permission outcome.
- `sections.tsx` — `ListingCard`, `LibraryEmptyIcon`. The native `page.tsx`
  imports both back, so both paths share one implementation; the spec
  places the card per item via `repeat` and the medallion as a widget.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged apart from rendering the shared card/medallion.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { ListingCard, LibraryEmptyIcon } from '../../app/(app)/apps/library/sections'

/* --- app library ------------------------------------------------------------ */
// One marketplace-listing card per row: icon medallion + version badge +
// title over a three-line description plus the key and the
// install/update client button. A composite cell (plain `<code>` beside a
// client component), so one component placed per item by the spec's
// `repeat`. Flat props (one scalar per prop): widget props resolve exactly
// one level deep, so the loader denormalizes each row and the spec binds
// per-item fields — `installed` and `current` travel as booleans, never a
// whole-row object. The button is NOT a separate widget: it is part of the
// card's footer row and never renders without it.
// EXACT prop shape: seven flat props — listingId: string, listingKey:
// string, name: string, versionLine: string, description: string,
// installed: boolean, current: boolean.
'listing-card': (props) => (
  <ListingCard
    listingId={str(props, 'listingId') ?? ''}
    listingKey={str(props, 'listingKey') ?? ''}
    name={str(props, 'name') ?? ''}
    versionLine={str(props, 'versionLine') ?? ''}
    description={str(props, 'description') ?? ''}
    installed={props.installed === true}
    current={props.current === true}
  />
),
// The empty/no-results medallion. Takes no props. NOT `apps-empty-icon`:
// that one renders Boxes; this page renders Library 21px.
'library-empty-icon': () => <LibraryEmptyIcon />,
```

Needed imports for the registry file (adjust to local style): the sections
import above. `str` already exists in that file; `Library` comes
transitively through the sections components, so no new lucide import is
needed in the registry.

`'apps-launcher-button'` and `'search-input'` already exist and need no
change:

- The docs header action reuses `apps-launcher-button` with
  `{ icon: 'book', variant: 'outline', size: 'sm' }` — the /apps
  INTEGRATION.md documents this as the outline-small 15px-BookOpen shape,
  which is byte-identical to this page's
  `<Button variant="outline" size="sm" asChild><Link><BookOpen size={15} />
  {label}</Link></Button>` (JSX `<Icon size={15} /> {label}` renders the
  icon, a space text node, then the label — the same three children).
- The search row reuses `search-input` with `placeholder` only — no
  `paramKey`, `pageParamKey` or `className` on this page, matching the
  registry's contract exactly.

## What the coordinator must NOT create

No new slot is needed. This page needs no org id, user id, Authz or bound
action in the spec: the spec binds only already-loaded rows and label
strings. `requirePermission('apps.manage')` runs in the loader (both
paths); the install POST stays inside the existing `InstallListingButton`
client component (part of the shared `ListingCard`), so no server action
crosses the spec boundary. Anything needing Authz or an org id goes
through a slot, and this page has nothing of that kind.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/apps/library',
  // Marketplace browser: card grid over fixture listings, bare pager, one
  // empty/resultless note branch, gated on `apps.manage` (the harness user
  // is super admin) plus the `apps` feature (default-on; the sim org sets
  // no override), so the page renders 200 in the harness tenant once the
  // fixture below lands.
  variants: [
    '',
    // Search narrows to one listing only (1 card): genuinely different
    // from the default (3 cards).
    { query: '?q=payroll', expect: 'main code', minMatches: 1 },
    // Deliberate empty result: asserts the resultless-note branch (a
    // listing table that is non-empty in the default variant, so this
    // CANNOT coincide with the virgin-library note), not card content.
    { query: '?q=zzzznomatch', expect: 'main h2', minMatches: 1 },
  ],
  expect: 'main code',
  minMatches: 3,
},
```

Verified against the database (`openbooks_sim_viewspec`): the
`app_listings` table is **EMPTY today** (zero rows), so every variant of
this page currently renders the virgin-library note — the fixture below is
load-bearing, not decorative. `minMatches: 3` and the `?q=payroll` single
hit are exact against the fixture (3 active listings; only one matches
"payroll"), not conservative. Re-verify after the coordinator lands the
fixture.

- The virgin-library note vs the resultless note: `params.q ? …noResults…
  : …empty…` — the `?q=zzzznomatch` variant pins the noResults copy over a
  non-empty table; the default variant never shows a note. Both sides of
  the conditional pair are covered.
- The `canManage=false` gate branch is permission-shaped and has no
  harness user to exercise it (`requirePermission('apps.manage')` throws
  before the flag is read). The null-description fallback IS covered (see
  fixture: `viewspec-lib-nodesc`).
- Selector notes: cards carry no link and no aria-label (unlike the /apps
  launcher), so the card pin is `main code` — one `<code>` key per card,
  rendered only in the card branch. The note pin is `main h2` — the native
  note title is an `<h2>`, matched by the spec's `heading(2)`.

## Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed ids, guard-before-insert where a UNIQUE makes
`ON CONFLICT (id)` useless (see below). Claims the fresh id block
`…1201-1203` (verified: zero occurrences of `00000000120` anywhere in
`scripts/`, `web/`, `packages/`).

```sql
  -- ---- app library (/apps/library): marketplace listings --------------------
  -- listListings reads app_listings (deployment-wide, not per-org), which is
  -- EMPTY in every environment — without rows the page compares two
  -- identical empty notes. Three active listings: two with descriptions
  -- (one matching "payroll", so ?q=payroll narrows 3 cards to 1) and one
  -- with a NULL description, so the `description || t('noDescription')`
  -- fallback renders real copy. GUARD before insert: app_listings has a
  -- UNIQUE on key (not just the id PK) and NO trigger or CHECK to defeat,
  -- so ON CONFLICT (id) DO NOTHING alone would raise on a re-run that
  -- re-seeds the same keys — the guard on key owns idempotence.
  -- Publisher is the SIM org (publisher_org_id is NOT NULL); manifest/files
  -- are NOT NULL so the rows carry the empty-manifest defaults.
  insert into app_listings (id, publisher_org_id, key, name, description, version, is_active)
  select '00000000-0000-7000-9000-000000001201', v_org, 'viewspec-lib-invoicing',
         'ViewSpec invoicing pack', 'Harness listing with a description', '2.3.0', true
   where not exists (select 1 from app_listings where key = 'viewspec-lib-invoicing');

  insert into app_listings (id, publisher_org_id, key, name, description, version, is_active)
  select '00000000-0000-7000-9000-000000001202', v_org, 'viewspec-lib-payroll',
         'ViewSpec payroll pack', 'Harness payroll listing', '1.0.0', true
   where not exists (select 1 from app_listings where key = 'viewspec-lib-payroll');

  insert into app_listings (id, publisher_org_id, key, name, description, version, is_active)
  select '00000000-0000-7000-9000-000000001203', v_org, 'viewspec-lib-nodesc',
         'ViewSpec nodesc listing', null, '0.9.0', true
   where not exists (select 1 from app_listings where key = 'viewspec-lib-nodesc');
```

- Sort order is `name, key`: "ViewSpec invoicing pack" < "ViewSpec nodesc
  listing" < "ViewSpec payroll pack". No order assertion in the conformance
  entry — only counts.
- Deliberately NO app installed in the SIM org under a `viewspec-lib-*`
  key, so every card renders the `installed=false` Install button (the
  update/installed states are permission- and tenant-shaped and have no
  harness variant).
- No `updated_at` is set (defaults to `now()`); the page never renders it.

## Could not express / needs coordinator action

Nothing structural. Two judgment calls, following the stated machinery
rules:

1. The card grid is `repeat` with `unwrapped`, not a `table`: cards are
   composite components (medallion + badge + title + description + footer
   row), not rows — the continuous-close page sets the precedent
   (`repeat` + `unwrapped` for non-tabular collections) and the /apps
   launcher is the in-family twin. `repeat.empty` is unused; the page's
   note is a separate presence-flagged `grid` because it carries different
   copy per branch (a variant that cannot differ from the default is not
   coverage).
2. The pager is `bare: true`: the native `Pagination` sits flush under the
   grid with no `mt-3` wrapper. The header docs action reuses the existing
   `apps-launcher-button` (outline/small/book) rather than minting a new
   entry: the shapes are byte-identical and a second entry would be a
   duplicate, not coverage.
3. The empty-note title is `heading(2)`, not `textBlock`: the native title
   is an `<h2>` and a text block renders a `<p>`. (`heading` renders in
   `blocks.tsx` and now validates — the schema gap the /apps handoff
   reported is closed.)
4. No `t()` key was invented: every message key in the loader
   (`title`, `library.*`, `version`, `noDescription`,
   `actions.documentation`) is used by the native page verbatim.
5. Client-side formatting trap: the page formats nothing client-side (no
   browser-locale dates/numbers — only server `t()` interpolation), and
   the install button's labels come from its own `useTranslations` hook at
   render time, so the loader passes raw booleans and lets the component
   do it. Nothing was pre-formatted that the component also formats.
