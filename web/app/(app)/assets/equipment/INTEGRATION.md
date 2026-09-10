# /assets/equipment ViewSpec integration handoff

Page: `/assets/equipment` — `web/app/(app)/assets/equipment/page.tsx`.
Loader + spec: `web/app/(app)/assets/equipment/view.ts`
(`loadEquipmentPage`, `equipmentSpec`).
Shared sections: `web/app/(app)/assets/equipment/sections.tsx`
(`EquipmentHeaderLinks`, `EquipmentKpiStrip` — moved here from `page.tsx`,
imported back, so both render paths share one implementation).

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

Imports (page-owned — `web/app/(app)/assets/equipment/**` — plus the shared
KPI strip):

```tsx
import { KpiStrip } from '../../components/kpi-strip'
import { EquipmentHeaderLinks } from '../../app/(app)/assets/equipment/sections'
import { NewEquipmentButton } from '../../app/(app)/assets/NewEquipmentButton'
import { EquipmentDrawer } from '../../app/(app)/assets/EquipmentDrawer'
```

Entries (`str` and `ComponentProps` are the existing local helpers):

```tsx
/* --- equipment ---------------------------------------------------------- */
'equipment-header-links': (props) => (
  <EquipmentHeaderLinks
    fixedAssetsLabel={str(props, 'fixedAssetsLabel') ?? ''}
    taxDepreciationLabel={str(props, 'taxDepreciationLabel') ?? ''}
    documentationLabel={str(props, 'documentationLabel') ?? ''}
    showFixedAssetsLinks={props.showFixedAssetsLinks === true}
  />
),
/** Loader-formatted Kpi[] straight through — KpiStrip markup is not stat-tile. */
'equipment-kpi-strip': (props) => (
  <KpiStrip items={(props.items as ComponentProps<typeof KpiStrip>['items']) ?? []} />
),
'new-equipment': () => <NewEquipmentButton />,
/** The remount key rides along as a prop: switching units must reset the
 *  drawer's client state, and a widget at a fixed position would otherwise
 *  be reused. */
'equipment-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof EquipmentDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <EquipmentDrawer key={remountKey} {...rest} />
},
```

Exact prop shapes (coordinator wires verbatim):

- `equipment-header-links`: `{ fixedAssetsLabel: string; taxDepreciationLabel: string; documentationLabel: string; showFixedAssetsLinks: boolean }`
- `equipment-kpi-strip`: `{ items: { label: string; value: string }[] }` (Kpi[] — tone/suffix omitted; the native strip never sets them)
- `new-equipment`: `{}` (no props — client button owns its POST + labels)
- `equipment-drawer`: `{ drawer: { remountKey: string; payload: LoadedEquipment; items: Opt[]; assets: Opt[]; books: Opt[]; subsidiaries: Opt[]; canManage: boolean; closeHref: string; fixedAssetsEnabled: boolean; projectsEnabled: boolean } }` where `Opt = { id: string; name: string; code?: string | null; number?: string | null }`

No new vocabulary. The spec uses only existing blocks: one `page-header`
(with the `new-equipment` action gated on `canManage`), the
`equipment-header-links` + `equipment-kpi-strip` widgets, and the shared
`entity-list-view` widget (`recordType: 'equipment_unit'`) with the drawer and
empty-state action threaded through widget refs. The slot re-derives
orgId/userId/permissions from the session, so the spec never carries a
capability or an org id.

## Proposed conformance entry (`scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`; harness user holds
`assets.read` + `assets.manage`, so the New button renders; `equipment`
defaults on per the feature registry; `fixedAssets` is on so the header
shows all three links).

Fixture (proposed — coordinator: append to `scripts/viewspec-fixtures.sql`;
claimed block **…1401-1499**, verified empty in the current file):

- `…1401` `items` row, kind `equipment_charge`, code `EQCH-VIEWSPEC`,
  name `Conformance excavator charge` (the unit's `charge_item` column
  inner-joins nothing, but the drawer picker and the charge-item label both
  need a real row to render against).
- `…1401`/`…1402` `equipment_units` rows on the SIM org's Main Co subsidiary
  (`3a7ddf65-35f1-4855-b297-f3c023a92d84`): one `active`
  (`EQ-VIEWSPEC-1`, purchase_price 85000, charge_item_id `…1401`), one
  `inactive` (`EQ-VIEWSPEC-2`, purchase_price 42000, no charge item). Unit
  numbers are unique per org (`equipment_units_org_number`), ids are fixed
  with `ON CONFLICT DO NOTHING`.

Measured against the live DB (psql, `app.bypass_rls='on'`):

- `equipment_units` in harness org: **0** today → **2** after the fixture
  (1 active, so the KPI strip reads `Active units = 1`).
- `items` kind `equipment_charge` active in harness org: **0** today → **1**
  after the fixture (the drawer charge-item picker shows 1 row).
- `item_rate_books` in harness org: **2** (no fixture needed — the drawer
  rate-book picker shows 2 rows). `fixed_assets`: **0** (assets picker empty;
  the drawer still opens — the picker is `clearable`).
- The `…1401`/`…1402` unit ids and the `…1401` item id return **0 rows** in
  the fixture file today (grep), so the claim is collision-free.

```js
{
  path: '/assets/equipment',
  // KPI strip + entity list (2 fixture rows), and the flyout with its live
  // pickers (1 charge item, 2 rate books, 0 fixed assets).
  variants: [
    '',
    {
      query: '?equipment=00000000-0000-7000-9000-000000001401',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Note: the `minMatches: 2` on the default variant counts the two fixture
units, not KPI tiles. The empty-`?q=` branch (shared EmptyState) is not
pinned — any search string is data-dependent once fixtures land.

## What could not be expressed

Nothing structural. Three judgment calls, all documented in `view.ts`:

1. The header link row is ONE `equipment-header-links` widget, not two
   presence-gated blocks: the native row is a single flex div, and two gated
   blocks would emit two divs when Fixed Assets is on.
2. The KPI strip is an `equipment-kpi-strip` widget carrying loader-formatted
   `Kpi[]` — `stat-tile` renders different markup and would re-derive
   KpiStrip badly (same call the forecasts page made).
3. The native body's `space-y-5` wrapper (KPI strip + list) is a spec-owned
   `grid('space-y-5', …)`: ListPageLayout's body has no such spacing, and only
   the spec path needs to reproduce it.
