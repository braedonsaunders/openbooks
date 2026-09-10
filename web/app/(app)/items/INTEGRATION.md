# /items ViewSpec integration handoff

Page: `/items` — item catalog entity list with an item flyout (`?item=`), plus
the re-homed Rate Books setup surface (`?view=rate-books`, gated on
`admin.setup.manage` + projects feature).

Files created/edited (all inside `web/app/(app)/items/`, the only dir this
page owns):

- `view.ts` — `loadItems(sp)` + `itemsSpec(data)`. The loader copies the
  native page's permission, feature, entity-lookup and picker logic verbatim
  (`items.read` / `items.manage` gates, the five feature flags, the
  `canSetup && projectsEnabled && view === 'rate-books'` rule,
  `loadItem` + four pickers, `drawerReturn` guard). The list itself renders
  through the existing `entity-list-view` slot; the loader never reimplements
  it. No `sections.tsx`: the page defines no local composite cells, and both
  header views are plain widgets.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { ModuleHomeTabs } from '../module-home/ui'
import { ItemDrawer } from '../../app/(app)/items/ItemDrawer'
import { NewItemButton } from '../../app/(app)/items/NewItemButton'
import { NewItemRedirect } from '../../app/(app)/items/NewItemRedirect'
import { SetupEntitySection } from '../../app/(app)/admin/setup/[entity]/SetupEntitySection'
import { SETUP_ENTITY_BY_KEY } from '../../lib/setup/registry'

/* --- items --------------------------------------------------------------- */
// One widget for the whole header-actions slot, because the native markup
// differs per view: the catalog view wraps `{viewChips}{<NewItemButton/>}`
// in `flex items-center gap-3` inside PageHeader's actions container; the
// rate-books view passes the bare tabs. `wrap` selects between them — data,
// not branching. `tabs` is empty when the setup gate fails (ModuleHomeTabs
// renders nothing for <2 tabs, matching the native null `viewChips`).
'items-header-actions': (props) => {
  const tabs = (props.tabs as ComponentProps<typeof ModuleHomeTabs>['tabs']) ?? []
  const inner = (
    <>
      <ModuleHomeTabs tabs={tabs} />
      {props.showNew === true ? <NewItemButton /> : null}
    </>
  )
  return props.wrap === true ? <div className="flex items-center gap-3">{inner}</div> : inner
},
'new-item': () => <NewItemButton />,
'new-item-redirect': () => <NewItemRedirect />,
// The remount key rides along as a prop: the native page renders
// `<ItemDrawer key={item.id}>` so switching items resets its client form
// state, and a widget at a fixed position would otherwise be reused.
'item-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof ItemDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <ItemDrawer key={remountKey} {...rest} />
},
// The re-homed Rate Books setup surface. A registry-driven CRUD surface
// (search, enum filters, pagination, drawer) that re-derives org id and
// permissions from the session — a capability, not data — so the spec names
// only the entity key and the base path; the entity lookup stays server-side
// (the spec can never select configuration). `sp` carries the raw search
// params (`q`, `showInactive`, `row`, `f_*`, `page`) the section already reads.
'setup-entity-section': (props) => {
  const entity = SETUP_ENTITY_BY_KEY.get(str(props, 'entityKey') ?? '')
  if (!entity) return null
  return (
    <SetupEntitySection
      entity={entity}
      orgId={/* re-derive from the session, as EntityListSlot does */}
      searchParams={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      basePath={str(props, 'basePath') ?? ''}
      canManage={/* re-derive from the session */}
    />
  )
},
```

`'entity-list-view'` and `'module-home-tabs'` already exist and need no
change. Note for the `setup-entity-section` entry: `SetupEntitySection` takes
`orgId` and `canManage`, neither of which may travel through a spec (same
cross-tenant reason `EntityListSlot` exists). The coordinator should resolve
both from the session inside the entry — `getAuthz()` + `can(authz,
'admin.setup.manage')` — exactly as `EntityListSlot` does for its three
capabilities. If the coordinator prefers a dedicated
`setup-entity-slot.tsx` (mirroring `entity-list-slot.tsx`), that file is the
coordinator's to create; this page needs no other slot.

Drawer fragment order (projects idiom): the `entity-list-view` slot already
accepts a LIST of drawer widget refs; the items spec passes
`[new-item-redirect?, item-drawer?]` in the native page's order.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/items',
  // Item catalog entity list (one row in the sim tenant) plus the item
  // flyout, portaled to <body>. The `?view=rate-books` variant needs the
  // harness admin to hold `admin.setup.manage` (it does, as role admin) and
  // renders the setup surface with zero rows — no assertion on rows there,
  // only that both paths render without throwing.
  variants: [
    '',
    '?view=rate-books',
    // The item flyout, portaled to <body>.
    {
      query: '?item=7f1ebdf1-28da-417c-9ed8-73fa1822c07b',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 1,
},
```

Verified against the database (`openbooks_sim_viewspec`, org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` — the harness org from the journal
handoff):

- `items` for this org: **1** (`Field Labor (T&M)`, kind `service`,
  `is_active = true`). The default list page size is 25, so the single row
  renders on page one — `minMatches: 1` is exact, not conservative.
- `item_rate_books` for this org: **0**, so the `?view=rate-books` variant
  exercises the empty setup table (its `empty` row), not a populated list.
  No fixture requested for it — the empty branch is a real branch worth
  covering.
- Drawer id `7f1ebdf1-28da-417c-9ed8-73fa1822c07b` is that same `Field Labor`
  row, active. It has `income_account_id`/`expense_account_id` set (verify
  per-run if the harness asserts picker contents).
- Sim-org feature settings: `{"scripts": true, "projects": true,
  "apiAccess": true, "subcontractorCompliance": true}` — `projects` is ON,
  so the `?view=rate-books` branch is reachable; whether the tabs render
  depends on the harness admin holding `admin.setup.manage`. If the harness
  user lacks that permission, `?view=rate-books` falls back to the catalog
  view and the variant still passes (same table), just without covering the
  setup surface — worth a coordinator check, not a fixture.

## Could not express

Nothing structural. Two coverage notes:

- The drawer edit-mode branch (client state inside `ItemDrawer`) is behavior
  of the shared component, identical on both paths — the harness compares the
  freshly opened read-only flyout.
- The `SetupEntitySection` drawer (`?view=rate-books&row=<id>`) has no
  fixture rows and needs none for this handoff; the empty-table branch is
  covered.
