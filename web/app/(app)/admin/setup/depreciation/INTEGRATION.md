# INTEGRATION — `/admin/setup/depreciation` ViewSpec conversion

Page: `web/app/(app)/admin/setup/depreciation/page.tsx`.
Loader/spec: `./view.ts` (`loadDepreciationSetup`, `depreciationSetupSpec`)
Shared chrome: `./sections.tsx` (`DepreciationSetupHeader`,
`DepreciationSetupTab` / `DepreciationSetupTabs` types)

This page is a two-tab workspace behind one `?tab=` param — the
tax-depreciation precedent at its smallest: `methods` (the user-authored
formula builder, `depreciation-methods`) and `books` (the per-book,
per-category policy list, `depreciation-book-policies`). Exactly one body
is alive per render, chosen by the loader-computed `onMethods` / `onBooks`
presence flags. The spec places the shared header chrome and the
already-registered `setup-section` slot; nothing else.

Deep-link contract, copied VERBATIM from the native page: `?tab=`
accepts the two `ENTITY_BY_TAB` keys (`Object.hasOwn` check), anything
else falls back to `methods`. One deliberate addition: the loader drops an
entity tab from `available` when its registry key is missing
(tax-depreciation precedent — the native `SetupEntitySection` would 404
via `SetupDrawer` lookup). Both keys exist today, so the behavior is
identical; the guard only fires if the registry ever drops one.

The native branch imports `DepreciationSetupHeader` back from
`./sections` (single implementation, per the brief). Its tab items are the
same `{ key, href, label, active }` shape the loader builds.

## Widget registry entries to add (coordinator)

One new widget. It renders the existing shared component verbatim — no new
markup invented here. `setup-section` (already registered) covers both
entity tabs; the spec names the entity by KEY only and the slot re-derives
org id, entry and manage gate from the session.

```tsx
import {
  DepreciationSetupHeader,
} from '../../app/(app)/admin/setup/depreciation/sections'

// Page header + tab strip. The native page owns an `<header>` (h1 +
// description) and an underline tab strip (NO `overflow-x-auto` on the nav,
// NO `shrink-0` on the links — two tabs fit, so the native page omits the
// scrolling treatment the tax-depreciation header carries) that no
// PageHeader block can express, so the whole row is one shared component
// over loader-resolved strings. The native branch imports it back (single
// implementation). `tabs` items are `{ key, href, label, active }` — flat
// props, except the tab list itself which arrives as one `tabs` array.
'depreciation-setup-header': (props) => (
  <DepreciationSetupHeader
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    tabs={(props.tabs as ComponentProps<typeof DepreciationSetupHeader>['tabs']) ?? []}
    tabsAria={str(props, 'tabsAria') ?? ''}
  />
),
```

EXACT prop shape: `{ title: string, description: string, tabs:
{ key: string, href: string, label: string, active: boolean }[],
tabsAria: string }`. The `setup-section` blocks carry the registered
shape exactly: `{ entityKey: string, sp: Record<string, string | string[]
| undefined>, basePath: string }` (`sp` is the raw searchParams object,
`basePath` is the literal `'/admin/setup/depreciation'`).

Slot remount keys: none needed. Neither the header nor the entity section
carries a `key` prop natively, so the registry must NOT invent one.

## Spec notes (`view.ts` as written)

- Layout `bare`: the setup workspace renders its own shell around every
  entity page. The spec owns its outer `<div className="space-y-5">` as a
  `grid` in body; `header` is empty — the payroll/[entity] precedent.
- The tab strip is NOT `module-home-tabs` (a pill strip): these are
  underline links, so they live in the shared header chrome with the
  payroll `PayrollSetupTabs` justification.
- `onMethods` / `onBooks` are mutually exclusive loader flags (accounts
  precedent). One `entityKey` field serves both tabs: the flags are
  exclusive, so exactly one `setup-section` block ever reads it (payroll
  `entityKeyFor` precedent).
- GATES checked, not just row counts: `requirePermission('admin.setup.manage')`
  gates the loader, and `requireFeatureEnabled(orgId, 'fixedAssets')` runs
  before any query. `authz`/`orgId` never enter the spec; the
  `setup-section` slot re-derives both plus the manage gate from the session.
- Money/dates: none on this page — the header is strings only, and the
  entity bodies render through the `setup-section` slot (cell formatting
  stays in `SetupEntitySection.renderCell` verbatim, including the
  en-US number format and the em-dash empties).
- Message keys: all resolved in the loader via the same key strings the
  native page uses (`title`, `description`, `tabsAria`, `tabs.methods`,
  `tabs.books` under `admin.setup.assetDepreciationSetup`). No invented
  keys. All other copy (entity titles, field labels, empty state) renders
  inside the slot, which reads the catalog itself.

## Proposed conformance registry entries (coordinator: `scripts/viewspec-conformance.mjs`)

DB state verified read-only against `openbooks_sim_viewspec` on
127.0.0.1:55439 (`app.bypass_rls='on'`), harness org `da472d3a-…`
(`viewspec@sim.test`): `fixedAssets` ON (org settings `features`
includes `"fixedAssets": true`), **0 depreciation_methods, 0
depreciation_book_policies**, 1 accounting_book (Primary),
1 asset_category (`ViewSpec machinery`, from the 99xx tax-depreciation
fixture). The default tab (`methods`) therefore renders the header + 2
tab links + the setup-entity empty row. After the fixture block below,
the methods list shows the seeded row and the books tab shows its seeded
policy row.

```js
{
  path: '/admin/setup/depreciation',
  // Tab workspace behind one `?tab=` param. The default and `?tab=bogus`
  // both land on methods (the native fallback contract, copied verbatim);
  // the books tab renders through the shared setup-section slot and lists
  // the seeded policy.
  variants: [
    '',
    { query: '?tab=bogus', expect: 'main nav a', minMatches: 2 },
    { query: '?tab=books', expect: 'main table tbody tr', minMatches: 1 },
  ],
  expect: 'main nav a',
  minMatches: 2,
},
{
  path: '/admin/setup/depreciation',
  // Methods tab WITH fixture: the seeded method row (first-column link).
  variants: [
    { query: '?tab=methods', expect: 'main table tbody tr', minMatches: 1 },
  ],
  expect: 'main table tbody tr',
  minMatches: 1,
},
```

## Proposed fixture SQL (coordinator: `scripts/viewspec-fixtures.sql`)

Fresh block `…4001-4002` — no existing fixture uses the 40xx range
(verified: `grep` over the file for `0000-7000-9000-000000004[0-9]` shows
zero hits; the allocation table lists `…0401-0499` as banking
statements, but the actual fixed ids in the file are `…000403-…000413`,
so `…004001+` is unclaimed). One method (`VS_SL`-shaped, plain
straight-line formula) plus one policy pointing the sim org's primary
book at the `ViewSpec machinery` category (seeded by the 99xx block).
Guard choice: the unique keys are `(org_id, code)` on
depreciation_methods and `(org_id, book_id, category_id)` on
depreciation_book_policies — NOT the ids — so `ON CONFLICT (id)` alone
would raise on re-run with changed business keys. Each guard owns its
idempotence via `WHERE NOT EXISTS` on the natural key. Book and category
ids resolve live from the sim org (never hardcoded); the
`fixed_asset_configuration_org_guard` trigger only constrains a
non-null `depreciation_method_id` (left NULL — the plain `method` enum
is used) so the policy insert is unaffected. The run is skipped if the
prerequisite book/category rows do not exist.

```sql
  -- ---- book depreciation setup (/admin/setup/depreciation) -----------------
  --
  -- One method + one book/category policy, so the methods tab lists one row
  -- and the books tab lists one row. Fresh 40xx block (no existing fixture
  -- uses it — the …0401-0499 banking ids are …000403-…000413, so …004001+
  -- is unclaimed). GUARD before insert: the natural keys are
  -- (org_id, code) / (org_id, book_id, category_id), not the ids — ON
  -- CONFLICT (id) alone would raise on a re-run with changed keys, so each
  -- guard owns its idempotence. Book/category resolve live from the sim org
  -- (the org-guard trigger only fires on a non-null
  -- depreciation_method_id, left NULL here); the run is skipped if none
  -- exist.
  insert into depreciation_methods (id, org_id, code, name, formula, end_of_life, is_active)
  select '00000000-0000-7000-9000-000000004001', v_org, 'VS_SL',
         'ViewSpec straight line', '(OC-RV)/AL', 'fully_depreciate', true
   where not exists (select 1 from depreciation_methods where org_id = v_org and code = 'VS_SL');

  insert into depreciation_book_policies (id, org_id, book_id, category_id, method, life_months, convention)
  select '00000000-0000-7000-9000-000000004002', v_org, b.id, c.id,
         'straight_line', 60, 'full_month'
    from (select id from accounting_books where org_id = v_org and is_primary limit 1) b,
         (select id from asset_categories where org_id = v_org and name = 'ViewSpec machinery' limit 1) c
   where b.id is not null and c.id is not null
     and not exists (select 1 from depreciation_book_policies p where p.org_id = v_org and p.book_id = b.id and p.category_id = c.id);
```

Deliberately NOT seeded: an inactive method (the `showInactive` toggle
branch — the setup-entity empty/active-toggle path is already covered by
other pages) and a `depreciation_method_id` override on the policy (the
formula-override drawer path is fetch-driven client state, not
URL-addressable).

## Could not express (and why)

Nothing structural — the one gap closes with existing machinery plus the
registry entry above:

1. The tab strip + header is shared chrome (`DepreciationSetupHeader`,
   imported back by the native branch — one implementation), because the
   active-vs-plain link PAIR and the conditional `aria-current` are a
   component, not a spec construct.
2. Both tab bodies are the already-registered `setup-section` slot — no
   new vocabulary needed. The drawer (with its formula textarea,
   account/asset-category/method ref pickers and POST/PATCH flows) stays
   inside `SetupEntitySection`/`SetupDrawer`, which the slot re-renders
   server-side; a spec cannot name fetch mutations or form state.
