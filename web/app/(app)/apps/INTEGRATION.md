# /apps ViewSpec integration handoff

Page: `/apps` — the app launcher (searchable, paginated grid of installed-app
cards, three empty-note branches, bare pager; gates `apps.use`, layout adds
the `apps` feature gate for the whole segment).

Files created (all inside `web/app/(app)/apps/`, the only dir this page owns):

- `view.ts` — `loadAppsLauncher(sp)` + `appsLauncherSpec(data)`. The loader
  copies the native page's query, permission and formatting logic verbatim
  (the `apps.use` gate, `installed` + `activeVersionId` filter, lowercase
  name/key/description search, name sort, 12-per-page slice, the
  `hasAnyInstalled` / `canManage` flags, `t('version', …)` lines,
  `description || t('noDescription')` fallback, `encodeURIComponent` hrefs,
  `t('actions.openAria', …)` labels).
- `sections.tsx` — `AppLauncherCard`, `AppsEmptyIcon`, `AppsLauncherButton`.
  The native `page.tsx` imports all three back, so both paths share one
  implementation; the spec places the card per item via `repeat` and the
  button/icon as widgets.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged apart from rendering the shared card/icon/button.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { AppLauncherCard, AppsEmptyIcon, AppsLauncherButton } from '../../app/(app)/apps/sections'

/* --- app launcher ---------------------------------------------------------- */
// One card per installed app: a link over a header row (icon medallion,
// name, version line) plus a two-line description plus the Open affordance.
// A composite cell, so one component placed per item by the spec's `repeat`.
// Flat props (one string per prop): widget props resolve exactly one level
// deep, so the loader denormalizes each row and the spec binds per-item
// fields — never a whole-row object.
'app-launcher-card': (props) => (
  <AppLauncherCard
    href={str(props, 'href') ?? ''}
    ariaLabel={str(props, 'ariaLabel') ?? ''}
    iconKey={str(props, 'iconKey') ?? ''}
    name={str(props, 'name') ?? ''}
    versionLine={str(props, 'versionLine') ?? ''}
    description={str(props, 'description') ?? ''}
    openLabel={str(props, 'openLabel') ?? ''}
  />
),
// The empty/no-results medallion. Takes no props.
'apps-empty-icon': () => <AppsEmptyIcon />,
// Header + empty-state action button. NOT `docs-link-button` (14px icon, no
// trailing-space handling), NOT `apps-library-button` (outline-only), NOT
// `link-button` (solid, no icon): the native header docs action is outline
// small with a 15px BookOpen icon and a space before the label, the header
// library action is SOLID DEFAULT with a 15px Library icon, and the
// empty-state CTA is solid small with `mt-4`. One parametric entry covers
// all three shapes; `className` passes through to the Button (the CTA's
// `mt-4`).
'apps-launcher-button': (props) => (
  <AppsLauncherButton
    href={str(props, 'href') ?? ''}
    label={str(props, 'label') ?? ''}
    icon={(str(props, 'icon') === 'book' ? 'book' : 'library')}
    variant={str(props, 'variant') === 'outline' ? 'outline' : undefined}
    size={str(props, 'size') === 'sm' ? 'sm' : undefined}
    className={str(props, 'className')}
  />
),
```

Needed imports for the registry file (adjust to local style): the sections
import above. `Button`, `Link`, `ComponentProps` and `str` already exist in
that file; `BookOpen`/`Library` come transitively through the sections
components, so no new lucide imports are needed in the registry.

`'search-input'` already exists and needs no change: the native page uses it
with exactly the registry's contract (`placeholder` only — no `paramKey`,
`pageParamKey` or `className` on this page).

## What the coordinator must NOT create

No new slot is needed. This page needs no org id, user id, Authz or bound
action in the spec: the spec binds only already-loaded rows and label
strings. `requirePermission('apps.use')` runs in the loader (both paths);
anything needing Authz or an org id goes through a slot, and this page has
nothing of that kind.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/apps',
  // App launcher: card grid over SIM-org fixtures, bare pager, three
  // empty-note branches, gated on `apps.use` (the harness user is super
  // admin) plus the `apps` feature (default-on; the sim org sets no
  // override), so the page renders 200 in the harness tenant once the
  // fixture below lands.
  variants: [
    '',
    // Search narrows to the demo app only (1 card): genuinely different
    // from the default (2 cards).
    { query: '?q=demo', expect: 'main a[aria-label^="Open"]', minMatches: 1 },
    // Deliberate empty result: asserts the no-results note branch
    // (hasAnyInstalled is true, so this CANNOT coincide with the
    // virgin-tenant note), not card content.
    { query: '?q=zzzznomatch', expect: 'main h2', minMatches: 1 },
  ],
  expect: 'main a[aria-label^="Open"]',
  minMatches: 2,
},
```

Verified against the database (`openbooks_sim_viewspec`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`):

- Launcher-visible rows today (`status='installed'` AND
  `active_version_id IS NOT NULL`): **1** (`viewspec-demo`; `noversion` has
  no active version, `archived` is disabled). The fixture below adds
  `viewspec-nodesc`, so the default variant renders **2 cards** —
  `minMatches: 2` is exact, not conservative. Re-verify after the
  coordinator lands the fixture.
- `?q=demo` matches only `viewspec-demo` (1 card): genuinely different from
  the default (2 cards). `?q=zzzznomatch` matches 0 cards with
  `hasAnyInstalled=true`, pinning the no-results note (not the virgin-tenant
  note — the harness tenant always has installed apps).
- The virgin-tenant note and its CTA (`emptyNoCta` / `emptyWithCta`) cannot
  be exercised in the harness tenant — fixtures only ever seed the SIM org,
  which always has installed apps. The null-description fallback IS covered
  (see fixture). The `canManage=false` gate branch is permission-shaped and
  has no harness user to exercise it.

## Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed id, `ON CONFLICT DO NOTHING`, SIM org only (same `v_org`
pattern as the existing blocks). Claims the fresh id block `…1104`, `…1112`
(the `…1101-1199` installed-apps block holds the admin-apps fixture at
`…1101-1103` (+ versions `…1111`, files `…1121-1122`, runs `…1131-1132`);
verified: zero occurrences of `000000001104` or `000000001112` anywhere in
the repo):

```sql
  -- ---- app launcher (/apps): no-description fallback -------------------------
  -- Same SIM-org apps the admin-apps block seeds, plus one installed app
  -- WITH an active version but a NULL description, so the launcher's
  -- `description || t('noDescription')` fallback renders real copy instead
  -- of coinciding with the demo app's description. GUARD before insert:
  -- the apps table has no trigger or CHECK to defeat, but the unique key
  -- is (org_id, key), not the id — ON CONFLICT (id) alone would raise on a
  -- re-run with a changed id, so the guard owns idempotence.
  insert into apps (id, org_id, key, name, description, status, granted_permissions)
  select '00000000-0000-7000-9000-000000001104', v_org, 'viewspec-nodesc', 'ViewSpec nodesc app',
         null, 'installed', '[]'
   where not exists (select 1 from apps where org_id = v_org and key = 'viewspec-nodesc');

  insert into app_versions (id, org_id, app_id, version, manifest, status)
  select '00000000-0000-7000-9000-000000001112', v_org,
         (select id from apps where org_id = v_org and key = 'viewspec-nodesc'), '0.1.0',
         '{"endpoints": []}', 'active'
   where not exists (select 1 from app_versions where id = '00000000-0000-7000-9000-000000001112');

  update apps set active_version_id = '00000000-0000-7000-9000-000000001112'
   where org_id = v_org and key = 'viewspec-nodesc'
     and active_version_id is null;
```

- `app_versions.manifest` is NOT NULL, so the version row carries the empty
  endpoints manifest; `version_id` linkage is the same deferred-FK
  back-link pattern the admin-apps fixture uses.
- No `sort_order` is set (defaults to 0, same as the three existing
  fixture apps) — launcher order is by name regardless.

## Could not express / needs coordinator action

**Schema gap (coordinator-owned, in `packages/viewspec/`): the `heading`
block renders (`case 'heading'` in `blocks.tsx`) and converted pages use it
(`platform/users/[id]`, `admin/setup/labor-costing`, `admin/setup/[entity]`,
`admin`), but `blockSchema` in `packages/viewspec/src/schema.ts` has NO
heading member — `validateSpec` rejects any spec containing one. I verified
this at runtime: all four branches of my spec fail `validateSpec` with
`body.1/2/3: Invalid input` (the three empty-note grids), each caused solely
by its `heading(2)` title block. The spec keeps `heading(2)` because byte
parity demands an `<h2>` (the native titles are `<h2>`; a `textBlock`
renders a `<p>`), and the page renders through `trusted` per the brief, so
this blocks only untrusted validation. The fix is one line in the
coordinator's file: add the heading member to the `blockSchema` union
(`level: z.union([z.literal(2), z.literal(3)])`, `content: value`,
`className` capped like the other blocks).

Judgment calls, following the stated machinery rules:

1. The card grid is `repeat` with `unwrapped`, not a `table`: cards are
   links wrapping composite markup, not rows — the continuous-close page
   sets the precedent (`repeat` + `unwrapped` for non-tabular collections).
   `repeat.empty` is unused; the page's three empty notes are separate
   presence-flagged `grid` blocks because each carries different copy and
   one carries a CTA (a variant that cannot differ from the default is not
   coverage).
2. The empty-note titles are `heading(2)`, not `textBlock`: the native
   titles are `<h2>`, and a text block renders a `<p>`. The icon medallion
   and the CTA button are widgets (`apps-empty-icon`,
   `apps-launcher-button`), not text cells: one is a component with an
   icon, the other an interactive control.
3. The header actions use the new parametric `apps-launcher-button`, not
   the existing `docs-link-button` / `apps-library-button`: the existing
   entries are byte-different (14px icon on the docs button; outline-only
   on the library button) and the header library action is a solid
   DEFAULT button. Reusing either would fail the byte comparison.
4. The pager is `bare: true`: the native `Pagination` sits flush under the
   grid with no `mt-3` wrapper.
5. `versionLine` renders `t('version', { version: '—' })` for apps with no
   version row — but every launcher-visible app BY DEFINITION has an active
   version with a version string (`activeVersionId` is non-null in the
   filter), so the "—" branch is unreachable on this page and gets no
   variant. The null-description fallback (reachable: `description` is
   nullable) gets the fixture instead.
