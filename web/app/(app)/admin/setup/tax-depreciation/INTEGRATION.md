# INTEGRATION — `/admin/setup/tax-depreciation` ViewSpec conversion

Page: `web/app/(app)/admin/setup/tax-depreciation/page.tsx`.
Loader/spec: `./view.ts` (`loadTaxDepreciationSetup`, `taxDepreciationSetupSpec`)
Shared chrome: `./sections.tsx` (`TaxDepreciationHeader`, `TaxDepreciationOverviewSlot`,
`TaxDepreciationOverview` / `TaxDepreciationSetupTabs` types)

This page is a tab workspace behind one `?tab=` param — the payroll
precedent: `overview` plus three registry-entity tabs (`regimes`,
`classes`, `first-year`), exactly one body alive per render, chosen by the
loader-computed `onOverview` / `onEntityTab` presence flags. The spec places
the shared header chrome, the overview slot, and the already-registered
`setup-section` slot; nothing else.

Deep-link contract, copied VERBATIM from the native page: `?tab=` accepts
`overview` and the three `ENTITY_BY_TAB` keys, anything else falls back to
`overview`. One deliberate addition: the loader drops an entity tab from
`available` when its registry key is missing (payroll precedent — the native
`SetupEntitySection` would 404 via `SetupDrawer` lookup). All three keys
exist today, so the behavior is identical; the guard only fires if the
registry ever drops one.

## Widget registry entries to add (coordinator)

Two new widgets. Both render existing components verbatim — no new markup
invented here. `setup-section` (already registered) covers the three entity
tabs; the spec names the entity by KEY only and the slot re-derives org id,
entry and manage gate from the session.

```tsx
import {
  TaxDepreciationHeader,
  TaxDepreciationOverviewSlot,
} from '../../app/(app)/admin/setup/tax-depreciation/sections'

// Page header + tab strip. The native page owns an `<header>` (h1 +
// description) and an underline tab strip (`shrink-0`, `aria-current`) that
// no PageHeader block can express, so the whole row is one shared component
// over loader-resolved strings. The native branch imports it back (single
// implementation). `descriptionClassName` is loader-resolved verbatim:
// `max-w-3xl` is present ONLY on the overview branch.
// `tabs` items are `{ key, href, label, active }` — flat props, except the
// tab list itself which arrives as one `tabs` array.
'tax-depreciation-header': (props) => (
  <TaxDepreciationHeader
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    descriptionClassName={str(props, 'descriptionClassName') ?? ''}
    tabs={(props.tabs as ComponentProps<typeof TaxDepreciationHeader>['tabs']) ?? []}
    tabsAria={str(props, 'tabsAria') ?? ''}
  />
),
// Overview body. Whole-component passthrough over ONE object prop:
// `overview` is exactly `Parameters<typeof TaxDepreciationSetup>[0]`
// (`{ companyCountry, packs, installedCodes, regimes, categories }`).
// Country names and pack sorting stay client-side (`countryOptions(locale)`
// + `localeCompare` inside the component — browser-locale formatting, so the
// loader passes raw country codes). No Authz, no org id, no actions.
'tax-depreciation-overview': (props) => (
  <TaxDepreciationOverviewSlot
    overview={props.overview as ComponentProps<typeof TaxDepreciationOverviewSlot>['overview']}
  />
),
```

Slot remount keys: none needed. Neither `TaxDepreciationSetup` nor the
header carries a `key` prop natively, so the registry must NOT invent one.

## Spec notes (`view.ts` as written)

- Layout `bare`: the setup workspace renders its own shell around every
  entity page. The spec owns its outer `<div className="space-y-5">` as a
  `grid` in body; `header` is empty — the payroll/[entity] precedent.
- The tab strip is NOT `module-home-tabs` (a pill strip): these are underline
  links with `-mb-px shrink-0` and `aria-current`, so they live in the shared
  header chrome with the payroll `PayrollSetupTabs` justification.
- `onOverview` / `onEntityTab` are mutually exclusive loader flags (accounts
  precedent). One `entityKey` field serves all three entity tabs: the flags
  are exclusive, so exactly one `setup-section` block ever reads it (payroll
  `entityKeyFor` precedent).
- GATES checked, not just row counts: `requirePermission('admin.setup.manage')`
  gates the loader, and `requireFeatureEnabled(orgId, 'fixedAssets')` runs
  before any query — the fixedAssets gate stays in the loader verbatim.
  `authz`/`orgId` never enter the spec; the `setup-section` slot re-derives
  both plus the manage gate from the session.
- Money/dates: the overview passes NO formatted values — `classCount` is a
  raw number formatted client-side by `t('classCount', { count })` (ICU
  plural via the browser locale), country names come from
  `countryOptions(locale)`, pack sort uses `localeCompare`. Per the
  client-format trap, the loader passes raw codes/counts and the component
  formats.
- Message keys: all resolved in the loader via the same key strings the
  native page uses (`title`, `description`, `tabsAria`, `tabs.overview`,
  `tabs.regimes`, `tabs.classes`, `tabs.firstYear`). No invented keys. All
  other copy (`packsTitle`, `models.*`, `links.*`, …) renders inside the
  client component, which reads the catalog itself.

## Proposed conformance registry entries (coordinator: `scripts/viewspec-conformance.mjs`)

DB state verified read-only against `openbooks_sim_viewspec` on
127.0.0.1:55439 (`app.bypass_rls='on'`), harness org `da472d3a-…`
(`viewspec@sim.test`): country US, `fixedAssets` ON, **0 tax_regimes, 0
tax_pool_classes, 0 asset_categories**. The five packs come from
`TAX_DEPRECIATION_REGIMES` (`ca_cca`, `uk_wda`, `au_pool`, `nz_pool`,
`us_macrs` — verified in `engine/src/tax-depreciation-pool.ts`), so the
overview renders the header + 4 tabs + 5 pack cards + 4 customize links and
NO assignments section. After the fixture block below, the assignments table
(1 regime × 1 category) renders too.

```js
{
  path: '/admin/setup/tax-depreciation',
  // Overview, empty tenant: 4 tab links + 5 pack cards + 4 customize links.
  // No assignments section (no regimes in this org).
  variants: [
    '',
    // Unknown tab falls back to overview (verbatim native contract).
    { query: '?tab=bogus', expect: 'main nav a', minMatches: 4 },
  ],
  expect: 'main nav a',
  minMatches: 4,
},
{
  path: '/admin/setup/tax-depreciation',
  // Overview WITH fixture: assignments table header (Asset category + the
  // seeded regime) plus the regime column per category row.
  variants: [
    { query: '', expect: 'main table thead th', minMatches: 2 },
  ],
  expect: 'main table thead th',
  minMatches: 2,
},
{
  path: '/admin/setup/tax-depreciation',
  // Entity tabs render through the registered setup-section slot: the
  // regimes list shows the seeded row; classes shows its seeded class row.
  // First-year rules stay empty (no first-year fixture — see below).
  variants: [
    { query: '?tab=regimes', expect: 'main table tbody tr', minMatches: 1 },
    { query: '?tab=classes', expect: 'main table tbody tr', minMatches: 1 },
  ],
  expect: 'main table tbody tr',
  minMatches: 1,
},
```

## Proposed fixture SQL (coordinator: `scripts/viewspec-fixtures.sql`)

Fresh block `…9901-9899` — no existing fixture uses the 99xx range (verified:
`grep` over the file shows 0001–8899 plus 1001–2009 only). One pool regime
(`ca_cca`-shaped, plain `pool` model), one class, one asset category whose
`tax_attributes` assigns it to that class. Guard choice: the unique keys are
`(org_id, code)` on tax_regimes, `(org_id, regime, class_code)` on
tax_pool_classes, and `(org_id, name)` on asset_categories — NOT the ids —
so `ON CONFLICT (id)` alone would raise on re-run with changed business
keys. The trigger `fixed_asset_configuration_org_guard` only constrains
`default_depreciation_method_id` (left NULL) and the three account ids (must
be active postable accounts in-tenant), so the category guard is a
`WHERE NOT EXISTS` on `(org_id, name)` plus account ids selected live from
the sim org (never hardcoded). The `asset_category_policy_guard` is
BEFORE UPDATE only — inserts are unaffected.

```sql
  -- ---- tax depreciation overview (/admin/setup/tax-depreciation) ------------
  --
  -- One pool regime + one class + one asset category assigned to that class,
  -- so the overview renders the assignments table (1 regime column) and the
  -- regimes/classes entity tabs each list one row. Fresh 99xx block (no
  -- existing fixture uses it). GUARD before insert: the natural keys are
  -- (org_id, code) / (org_id, regime, class_code) / (org_id, name), not the
  -- ids — ON CONFLICT (id) alone would raise on a re-run with changed keys,
  -- so each guard owns its idempotence. Category accounts resolve live from
  -- the sim org (the org-guard trigger requires active postable in-tenant
  -- accounts); the run is skipped if none exist.
  insert into tax_regimes (id, org_id, code, name, country_code, calculation_model, class_attribute, is_active)
  select '00000000-0000-7000-9000-000000009901', v_org, 'VS_POOL',
         'ViewSpec pool regime', 'CA', 'pool', 'vs_pool_class', true
   where not exists (select 1 from tax_regimes where org_id = v_org and code = 'VS_POOL');

  insert into tax_pool_classes (id, org_id, regime, class_code, name, rate, method, first_year_fraction, is_active)
  select '00000000-0000-7000-9000-000000009902', v_org, 'VS_POOL', 'VS_8',
         'ViewSpec class 8', 0.20, 'declining', 1, true
   where not exists (select 1 from tax_pool_classes where org_id = v_org and regime = 'VS_POOL' and class_code = 'VS_8');

  insert into asset_categories (id, org_id, name, asset_account_id,
         accumulated_depreciation_account_id, depreciation_expense_account_id,
         tax_attributes, is_active)
  select '00000000-0000-7000-9000-000000009903', v_org, 'ViewSpec machinery',
         a.asset_id, a.accum_id, a.exp_id,
         '{"vs_pool_class": "VS_8"}'::jsonb, true
    from (select
            (select id from accounts where org_id = v_org and is_active and not is_summary order by number limit 1) as asset_id,
            (select id from accounts where org_id = v_org and is_active and not is_summary order by number limit 1 offset 1) as accum_id,
            (select id from accounts where org_id = v_org and is_active and not is_summary order by number limit 1 offset 2) as exp_id) a
   where a.asset_id is not null and a.accum_id is not null and a.exp_id is not null
     and not exists (select 1 from asset_categories where org_id = v_org and name = 'ViewSpec machinery');
```

Deliberately NOT seeded: `tax_first_year_rules` (the `?tab=first-year`
entity tab renders its empty state — a variant that cannot differ from the
default list-empty path is not coverage, and the setup-entity empty row is
already covered by other pages).

## Could not express (and why)

Nothing structural — both gaps close with existing machinery plus the two
registry entries above:

1. The tab strip + header is shared chrome (`TaxDepreciationHeader`,
   imported back by the native branch — one implementation), because the
   active-vs-plain link PAIR and the conditional `aria-current` are a
   component, not a spec construct.
2. The overview body is a whole-component slot (`TaxDepreciationOverviewSlot`
   spreading ONE `overview` object onto the existing `TaxDepreciationSetup`
   client component): pack install buttons are POST fetch flows, the
   assignment Selects are PATCH flows, and the recommended-pack sort uses
   browser-locale `localeCompare` — all unnameable in a spec. The loader
   passes raw codes/counts; the component formats client-side.
