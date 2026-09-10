# /inventory ViewSpec integration handoff

Page: `/inventory` — `web/app/(app)/inventory/page.tsx`.
Loader + spec: `web/app/(app)/inventory/view.ts`
(`loadInventory`, `inventorySpec`).
Page-owned slot: `web/app/(app)/inventory/InventorySetupSlot.tsx`.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

Imports:

```tsx
import { InventorySetupSlot } from '../../app/(app)/inventory/InventorySetupSlot'
import { NewMovementButton } from '../../app/(app)/inventory/NewMovementButton'
import { InventoryActionDrawer } from '../../app/(app)/inventory/InventoryActionDrawer'
```

Entries (`str` and `ComponentProps` are the existing local helpers):

```tsx
/* --- inventory ---------------------------------------------------------- */
'new-movement': () => <NewMovementButton />,
'inventory-action-drawer': (props) => (
  <InventoryActionDrawer
    items={(props.items as ComponentProps<typeof InventoryActionDrawer>['items']) ?? []}
    stockLocations={
      (props.stockLocations as ComponentProps<typeof InventoryActionDrawer>['stockLocations']) ?? []
    }
    accounts={(props.accounts as ComponentProps<typeof InventoryActionDrawer>['accounts']) ?? []}
  />
),
/* --- shared: registry-backed setup sections --------------------------- */
'inventory-setup-section': (props) => (
  <InventorySetupSlot
    entityKey={str(props, 'entityKey') ?? ''}
    sp={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    basePath={str(props, 'basePath') ?? ''}
  />
),
```

No new vocabulary. The spec uses only existing blocks: one `page-header`
(title, description, actions class `flex items-center gap-3` matching the
native actions div), `module-home-tabs`, and two presence-gated
`entity-list-view` blocks (`inventory_onhand`, `inventory_movement`).

## Proposed slot: `InventorySetupSlot`

`web/app/(app)/inventory/InventorySetupSlot.tsx` (written, page-owned).
It takes `entityKey`, `sp`, `basePath`; it looks the entry up in
`SETUP_ENTITY_BY_KEY` (code, so it cannot travel through a spec) and
re-derives `orgId` and the `admin.setup.manage` decision from the session —
same doctrine as the entity-list slot. The `canManage` prop the spec carries
is a redundant presence flag for the `when` clause only, mirroring the native
`setupEntity !== null` check.

Why not `related-txn-drawer`-style sharing: the setup section is not a
drawer and its registry entry must match the keys the loader resolved
(`stock-locations`, `bom-components`). A shared `setup-entity-section` slot
would work identically; I kept it page-owned to stay inside my directory —
promote freely if another page re-homes a setup tab.

## Proposed conformance entry (`scripts/viewspec-conformance.mjs`)

The harness refuses to compare pages with no rows, and the sim org currently
has none of the rows this page renders:

- `items` (active): 1 (`Field Labor (T&M)`, kind `service` — no costing profile).
- `item_inventory_profiles`: 0 → `inventory_onhand` is empty (its table only
  reads `cost_layers`).
- `inventory_movements`: 0.
- `stock_locations`: 0, `bom_components`: 0.

Verified with `set app.bypass_rls='on'` count queries against
`openbooks_sim_viewspec` for org `da472d3a-…` (harness user
`viewspec@sim.test` holds `items.read`, `items.manage`,
`admin.setup.manage`, so all four tabs and the drawer render).

With the fixture SQL below applied, the default render has ≥1 on-hand row
and ≥1 movement row (each list renders its own `table tbody tr`), the two
config tabs each render ≥1 registry row, and `?movement=new` opens the
drawer with 1 item option, 1 location option, and 66 account options:

```js
{
  path: '/inventory',
  // Four searchParam-driven sections: two entity lists, two registry-backed
  // config tabs, and the create-movement drawer (a client island fed by
  // three picker queries the loader runs verbatim).
  variants: [
    { query: '?inventoryView=movements', expect: 'table tbody tr', minMatches: 2 },
    { query: '?inventoryView=locations', expect: 'table tbody tr', minMatches: 1 },
    { query: '?inventoryView=bom', expect: 'table tbody tr', minMatches: 1 },
    {
      query: '?movement=new',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 1,
},
```

Legacy `?view=movements` resolves identically to `?inventoryView=movements`
(the loader keeps the fallback verbatim); no separate variant needed. The
drawer variant relies on the fixture rows below — without them it renders
no drawer content change (the drawer still opens, but the harness only
sees the empty pickers).

## Fixture SQL (coordinator: fold into `scripts/viewspec-fixtures.sql`)

Conventions followed: fixed ids under `00000000-0000-7000-9000-…` (continuing
past the continuous-close block, which ends at `…101`), `ON CONFLICT DO
NOTHING`, only the SIM org, `set app.bypass_rls='on'` already at file top.
FK targets verified in the sim org: subsidiary
`3a7ddf65-…`, HQ location `d2f40596-…`, accounts `1010` (`a1f8e08f-…`),
`1020` (`91103b65-…`). Kind enums verified against the kernel and the
registry: item kinds include `inventory`/`assembly`/`kit`
(`ItemDrawer.tsx`), movement kinds include `receipt`/`issue`
(`advanced/route.ts`), location kinds include `warehouse`/`bin`
(`STOCK_LOCATION_KINDS`). `quantity <> 0` is a CHECK on
`inventory_movements`; `cost_layers.remaining_quantity > 0` is what the
on-hand table reads.

```sql
  -- Inventory conformance rows: one stocked item (profile + location + a
  -- receipt layer and its movement), one issued movement for the kind
  -- filter, one config row per re-homed tab. The movements list shows each
  -- posted movement; the on-hand list aggregates the open layer.
  --
  -- FK targets (subsidiary, HQ location, 1010/1020 accounts) resolve from
  -- the SIM org at seed time so the block survives tenant rebuilds; only
  -- the seeded rows themselves use fixed ids. (Declare alongside the other
  -- block variables at the top of the fixtures file: v_sub uuid; v_loc
  -- uuid; v_acct_asset uuid; v_acct_cogs uuid.)
  select id into v_sub from subsidiaries where org_id = v_org order by name limit 1;
  select id into v_loc from locations where org_id = v_org order by code limit 1;
  select id into v_acct_asset from accounts
   where org_id = v_org and number = '1010' limit 1;
  select id into v_acct_cogs from accounts
   where org_id = v_org and number = '1020' limit 1;
  insert into items (id, org_id, kind, code, name, is_active)
  values ('00000000-0000-7000-9000-000000000201', v_org, 'inventory', 'WIDGET-001', 'Conformance widget', true)
  on conflict (id) do nothing;
  insert into items (id, org_id, kind, code, name, is_active)
  values ('00000000-0000-7000-9000-000000000202', v_org, 'inventory', 'GADGET-002', 'Conformance gadget', true)
  on conflict (id) do nothing;
  insert into item_inventory_profiles (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, base_unit)
  values ('00000000-0000-7000-9000-000000000203', v_org, '00000000-0000-7000-9000-000000000201',
          'moving_average', 'none', v_acct_asset, v_acct_cogs, 'ea')
  on conflict (id) do nothing;
  insert into stock_locations (id, org_id, location_id, code, kind, is_active)
  values ('00000000-0000-7000-9000-000000000204', v_org, v_loc, 'MAIN', 'warehouse', true)
  on conflict (id) do nothing;
  insert into inventory_movements (id, org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, status)
  values ('00000000-0000-7000-9000-000000000205', v_org, v_sub,
          '00000000-0000-7000-9000-000000000201', 'receipt', now() - interval '2 days',
          '00000000-0000-7000-9000-000000000204', 10, 25.50, 255.00, 'posted')
  on conflict (id) do nothing;
  insert into inventory_movements (id, org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, status)
  values ('00000000-0000-7000-9000-000000000206', v_org, v_sub,
          '00000000-0000-7000-9000-000000000201', 'issue', now() - interval '1 day',
          '00000000-0000-7000-9000-000000000204', 2, 25.50, 51.00, 'posted')
  on conflict (id) do nothing;
  insert into cost_layers (id, org_id, subsidiary_id, item_id, stock_location_id, source_movement_id, received_at, original_quantity, remaining_quantity, unit_cost)
  values ('00000000-0000-7000-9000-000000000207', v_org, v_sub,
          '00000000-0000-7000-9000-000000000201', '00000000-0000-7000-9000-000000000204',
          '00000000-0000-7000-9000-000000000205', now() - interval '2 days', 10, 8, 25.50)
  on conflict (id) do nothing;
  insert into bom_components (id, org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
  values ('00000000-0000-7000-9000-000000000208', v_org,
          '00000000-0000-7000-9000-000000000202', '00000000-0000-7000-9000-000000000201', 2, 0)
  on conflict (id) do nothing;
```

Expected post-fixture counts (harness org): `inventory_onhand` 1 row
(the open layer), `inventory_movements` 2 rows, `stock_locations` 1 row,
`bom_components` 1 row. The `?movement=new` drawer then offers 1 item
(the only profiled active item), 1 location, 66 accounts.

## What could not be expressed

Nothing structural. Three judgment calls, all with precedent:

1. The setup tabs (`locations`, `bom`) render the whole
   `SetupEntitySection` server component as one widget — same reasoning as
   the approvals statement matrix and the assets tax pools. The registry
   lookup and the `canSetup` gate stay in the loader verbatim, so a reader
   without `admin.setup.manage` falls back to the movements list exactly as
   the native page does (the loader computes `setupEntity` first and the
   presence flags from it).
2. The drawer goes through the entity list's drawer slot (not a separate
   body block) because the native page passes it as EntityListView's
   `drawer` prop; the slot already accepts a list, so redirect-then-drawer
   ordering follows the projects pattern.
3. `ModuleHomeTabs` needs ≥2 tabs to render anything; when the reader lacks
   `admin.setup.manage` there are exactly 2 ledger tabs, so the strip always
   renders on this page — no presence flag needed.
