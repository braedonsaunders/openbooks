# /assets ViewSpec integration handoff

Page: `/assets` — `web/app/(app)/assets/page.tsx`.
Loader + spec: `web/app/(app)/assets/view.ts` (`loadAssets`, `assetsSpec`).
Shared sections: `web/app/(app)/assets/sections.tsx`
(`AssetsTabs`, `AssetsDocLink`, `AssetsEquipmentLink` — moved here from
`page.tsx`, imported back, so both render paths share one implementation).

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

Imports (all page-owned — `web/app/(app)/assets/**`):

```tsx
import { AssetsTabs, AssetsDocLink, AssetsEquipmentLink } from '../../app/(app)/assets/sections'
import { NewAssetButton } from '../../app/(app)/assets/NewAssetButton'
import { NewAssetRedirect } from '../../app/(app)/assets/NewAssetRedirect'
import { RunDepreciationButton } from '../../app/(app)/assets/RunDepreciationButton'
import { AssetDrawer } from '../../app/(app)/assets/AssetDrawer'
import { TaxPoolsView } from '../../app/(app)/assets/tax-pools/TaxPoolsView'
```

Entries (`str` and `ComponentProps` are the existing local helpers):

```tsx
/* --- fixed assets ------------------------------------------------------- */
'assets-tabs': (props) => (
  <AssetsTabs tabs={(props.tabs as ComponentProps<typeof AssetsTabs>['tabs']) ?? []} />
),
'assets-doc-link': (props) => (
  <AssetsDocLink label={str(props, 'label') ?? ''} />
),
'assets-equipment-link': (props) => (
  <AssetsEquipmentLink label={str(props, 'label') ?? ''} />
),
'new-asset': () => <NewAssetButton />,
'new-asset-redirect': () => <NewAssetRedirect />,
'run-depreciation': (props) => (
  <RunDepreciationButton
    books={(props.books as ComponentProps<typeof RunDepreciationButton>['books']) ?? []}
  />
),
/** The remount key rides along as a prop: switching assets must reset the
 *  drawer's client state, and a widget at a fixed position would otherwise
 *  be reused. */
'asset-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof AssetDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <AssetDrawer key={remountKey} {...rest} />
},
'tax-pools': (props) => (
  <TaxPoolsView
    canRun={props.canRun === true}
    canConfigure={props.canConfigure === true}
    regimes={(props.regimes as ComponentProps<typeof TaxPoolsView>['regimes']) ?? []}
    defaultTaxYear={typeof props.defaultTaxYear === 'number' ? props.defaultTaxYear : 0}
  />
),
```

No new vocabulary. The spec uses only existing blocks: two presence-gated
`page-header`s (register with actions vs tax without — the native tax tab
renders `PageHeader` with NO actions prop, so one header with conditional
actions would emit a wrapper the native render does not have), the
`entity-list-view` widget with a LIST drawer slot (create-redirect, then the
record flyout, in the native page's order), and the `tax-pools` widget.

`RecordListView` slot question from the task: no new slot is needed. The page
uses `EntityListView` (`recordType: 'fixed_asset'`), which already arrives
through the shared `entity-list-view` widget and
`web/components/viewspec/entity-list-slot.tsx` — the slot re-derives
orgId/userId/permissions from the session, so the spec never carries a
capability or an org id.

## Proposed conformance entry (`scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-…`, US, `fixedAssets` on by default):

- `fixed_assets` in harness org: **0** → default render shows the entity
  list's shared empty state (`common.empty.title` / `common.empty.description`
  + the `new-asset` action). Selector: `main h3`, minMatches 1.
- `?tab=tax-depreciation` → header without actions, the `tax-pools` island
  (regime select + tax-year input; regimes resolve from the US built-ins
  since the org has no active `tax_regimes` rows). Selector:
  `main select, main input`, minMatches 1.
- Books query for the harness org returns 1 row (`Primary`), so the
  `run-depreciation` single-book branch (plain button) is exercised on the
  register tab.

```js
{
  path: '/assets',
  // Two tabs over different machinery: the universal entity list (empty in
  // the sim org — 0 fixed_assets) and the interactive tax-pools island.
  variants: [
    '',
    { query: '?tab=tax-depreciation', expect: 'main select, main input', minMatches: 1 },
  ],
  expect: 'main h3',
  minMatches: 1,
},
```

Note: I could not verify a drawer variant — no asset id exists in the sim
org to open (`?asset=<uuid>` needs a row). If the coordinator adds an asset
fixture, the drawer variant should assert `[data-drawer-layer]` with scopes
`['main', '[data-drawer-layer]']` like the accounts/party entries.

## What could not be expressed

Nothing structural. Two judgment calls, both documented in `view.ts`:

1. The register header is split into TWO `page-header` blocks gated by
   `onRegister`/`onTax` (presence, not branching) because the native tax tab
   renders `PageHeader` with no `actions` prop at all.
2. `Books: depreciationBooks.rows` passes the raw `db.execute` rows through
   the spec as widget props — plain `{ id, name, is_primary }` objects. The
   slot resolves them server-side into `RunDepreciationButton`, which keeps
   its own `useState` book selection; the spec carries no function values.
