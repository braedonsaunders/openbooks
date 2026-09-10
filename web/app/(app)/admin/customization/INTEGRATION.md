# INTEGRATION — `/admin/customization` ViewSpec conversion

Page: `web/app/(app)/admin/customization/page.tsx`.
Status: **converted, pending vocabulary.** `view.ts`, `sections.tsx`, and the
`__viewspec` branch in `page.tsx` are written; the spec references the widget
names proposed below, which do not exist in `WIDGET_REGISTRY` yet. Until the
coordinator registers them, the `?__viewspec=1` path throws
`UnknownWidgetError` at render — the native branch is untouched and ships.

No `packages/viewspec` language change is needed: everything below is a
registry entry (whole-component passthrough, same pattern as `view-studio` /
`card-studio` / `type-builder-drawer`), plus `sections.tsx` composites that
already exist in this directory and are shared back into the native branch
(single implementation: `CustomizationTabs`, `FormDefaultCell`,
`ViewScopeCell`).

## 1. Proposed `WIDGET_REGISTRY` entries (coordinator: `web/components/viewspec/widgets.tsx`)

```tsx
import { SearchSelectFilter } from '../filter-bar'
import {
  FormDesigner,
  NewFormButton,
} from '../../app/(app)/admin/customization/FormDesigner'
import {
  ListViewDesigner,
  NewViewButton,
} from '../../app/(app)/admin/customization/ListViewDesigner'
import { CustomizationTabs } from '../../app/(app)/admin/customization/sections'

// Tab strip. The native page renders two plain Links in a bordered pill with
// teal-active classes — NOT the Badge links `toggle-links` renders, so the
// existing group cannot do this. `CustomizationTabs` already exists in this
// page's `sections.tsx` (imported back by the native branch — one
// implementation); only the registry entry is missing:
'customization-tabs': (props) => (
  <CustomizationTabs
    formsHref={str(props, 'formsHref') ?? ''}
    viewsHref={str(props, 'viewsHref') ?? ''}
    formsLabel={str(props, 'formsLabel') ?? ''}
    viewsLabel={str(props, 'viewsLabel') ?? ''}
    formsActive={props.formsActive === true}
    showForms={props.showForms !== false}
  />
),

// Record-type dropdown. Different component AND different contract from
// `filter-chips` (router.replace + resetParamKeys, no basePath navigation),
// so it needs its own entry:
'search-select-filter': (props) => (
  <SearchSelectFilter
    paramKey={str(props, 'paramKey') ?? ''}
    label={str(props, 'label') ?? ''}
    options={(props.options as ComponentProps<typeof SearchSelectFilter>['options']) ?? []}
    allLabel={str(props, 'allLabel')}
    resetParamKeys={(props.resetParamKeys as string[]) ?? []}
  />
),

// Header "New" buttons. Client components (router.push); `recordType` arrives
// as a loader-resolved prop. `when` gates: new-form shows only when a record
// type is picked AND the forms tab is active; new-view when a type is picked
// AND the views tab is active.
'new-form': (props) => <NewFormButton recordType={str(props, 'recordType') ?? ''} />,
'new-view': (props) => <NewViewButton recordType={str(props, 'recordType') ?? ''} />,

// Header docs button. NOT `link-button`: that renders a solid Button with no
// icon, while the native page is `variant="outline" size="sm"` with a
// BookOpen icon — class strings must be identical. Either a dedicated entry:
'docs-link-button': (props) => {
  const href = str(props, 'href')
  if (!href) return null
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href as never}><BookOpen size={14} aria-hidden />{str(props, 'label') ?? ''}</Link>
    </Button>
  )
},
// (imports: `BookOpen` from 'lucide-react'; `Button` and `Link` already imported)

// Designer drawers. Whole-component passthrough, exactly like `view-studio` /
// `card-studio`: the drawer owns unsaved client state and is never decomposed.
// `when`: form drawer opens when `form` param is set; view drawer when `view`
// param is set. Props are loader-resolved field refs; `def`/`headerDefs`/
// `lineDefs`/`duplicateFrom`/`filterOptions`/`showInListDefs` are the
// presentation-ready objects the native page already builds.
'form-drawer': (props) => (
  <FormDesigner
    recordType={str(props, 'recordType') ?? ''}
    def={(props.def as ComponentProps<typeof FormDesigner>['def']) ?? null}
    headerDefs={(props.headerDefs as ComponentProps<typeof FormDesigner>['headerDefs']) ?? null}
    lineDefs={(props.lineDefs as ComponentProps<typeof FormDesigner>['lineDefs']) ?? null}
    duplicateFrom={(props.duplicateFrom as ComponentProps<typeof FormDesigner>['duplicateFrom']) ?? null}
    subsidiaryEnabled={props.subsidiaryEnabled === true}
  />
),
'list-view-drawer': (props) => (
  <ListViewDesigner
    recordType={str(props, 'recordType') ?? ''}
    def={(props.def as ComponentProps<typeof ListViewDesigner>['def']) ?? null}
    canManageOrg={props.canManageOrg === true}
    userId={str(props, 'userId') ?? ''}
    showInListDefs={(props.showInListDefs as ComponentProps<typeof ListViewDesigner>['showInListDefs']) ?? []}
    filterOptions={(props.filterOptions as ComponentProps<typeof ListViewDesigner>['filterOptions']) ?? {}}
    inventoryEnabled={props.inventoryEnabled === true}
    crmEnabled={props.crmEnabled === true}
  />
),
```

Views-tab `EmptyState` action. The spec passes `action` (a widget name resolved
by the loader: `'new-view'` when a record type is picked, `''` otherwise) plus
`actionProps: { recordType }`. The current `empty-state` widget resolves its
`action` by name and calls `renderer({})` with NO props — so it needs a small
coordinator-side change to forward `actionProps` through:
`renderer(resolveWidgetProps(props.actionProps, scope))`. `str(props,
'action')` already returns `undefined` for the `''` case (non-string guard is
for non-strings; empty string is falsy-safe via `action ? ... : undefined`),
so the no-record-type case renders no action, matching the native
`action={recordType ? <NewViewButton/> : undefined}`.

## 2. Spec notes (`view.ts` as written)

No new block/cell kinds. The loader copies the native query/permission logic
verbatim (`getAuthz` + `can(authz, 'admin.customization.manage')`,
`disabledRecordTypes` gating with `notFound`, `parseListParams` with
`perPage: 100`, the four parallel list/count queries, `duplicateFrom`,
`loadFieldDefs`, the 18-way `entityFilters` switch). Two deliberate deltas
from a pure copy, both presentation-shaping the loader owns: per-row hrefs
are prebuilt strings (the spec cannot build query strings), and the mutually
exclusive branches are presence flags (`showBack`/`hideBack`,
`showFormsTable`/`showViewsTable`/`showViewsEmpty`, `showFormsPager` /
`showViewsPager`).

- Header: `pageHeader` with docs + new-form/new-view widgets in `actions`
  (fragment — native wraps actions in `<>`, and `WidgetSlot` without
  `actionsClassName` renders a fragment, so no wrapper). Back link is
  conditional (`canManageOrg`): use TWO `page-header` blocks with
  complementary loader flags (`showBack` / `hideBack`) — the accounts-page
  precedent ("mutually exclusive bodies chosen by presence flags"). `back`
  itself cannot be conditional inside one block.
- Toolbar: `grid('flex flex-wrap items-center gap-2', …)` holding
  `customization-tabs`, `search-select-filter`, `search-input` widgetBlocks —
  same order and wrapper class as the native `<div>`.
- Body: three mutually exclusive branches via loader flags (accounts
  precedent): `showFormsTable`, `showViewsTable`, `showViewsEmpty`. Note the
  native forms tab has NO empty treatment (empty result = headers + zero rows);
  only the views tab uses `EmptyState`.
- Forms table (`app` variant): name `link` cell (loader-built href, class
  `font-medium text-teal-700 hover:underline dark:text-teal-300`), type
  `badge(secondary)`, status `badge(success|outline)`, default cell =
  composite in `sections.tsx` (`{isDefault ? Badge(default) : null}{' '}{roles
  ? <span className="text-xs text-slate-400">…</span> : null}` — a
  `widgetCell`, since `badge-or-dash` renders an em-dash when hidden and this
  renders nothing), duplicate `link` cell right-aligned (`column(align:
  'right')` — check how native `TableCell className="text-right"` maps; the
  api-keys actions column used `headerClassName: 'w-24'`, so confirm align
  propagation for right cells with the coordinator).
- Views table: name link, type badge, scope cell = composite in `sections.tsx`
  (scope badge default|secondary + conditional `isDefault` outline badge),
  status badge.
- Pagination: `when` flags (`totalForms > perPage`, `totalViews > perPage`) —
  the native page omits the pager (including its `mt-3` wrapper) below the
  threshold, and the `pagination` block's wrapper supplies exactly that `mt-3`.
  `bare` must NOT be set.
- Drawers: `form-drawer` / `list-view-drawer` widgetBlocks with `when`
  (`formId && designerRecordType`, `viewId && designerRecordType`).

Message keys (all verified in `web/messages/en/customization.json`,
`common.json`, `admin.json` — no invented keys): `designer.title`,
`designer.description`, `designer.documentation`, `designer.recordTypeFilter`,
`designer.allRecordTypes`, `designer.searchPlaceholder`,
`designer.tabs.forms`, `designer.tabs.views`, `designer.forms.name`,
`designer.forms.isDefault`, `designer.forms.duplicate`,
`designer.forms.copyName`, `designer.forms.standardName`,
`designer.list.name`, `designer.list.newTitle`, `designer.list.scope`,
`designer.list.scopeOrg`, `designer.list.scopeUser`,
`designer.list.isDefault`, `views.defaultBadge`, `common.labels.type`,
`common.labels.status`, `common.labels.actions`, `common.labels.active`,
`common.labels.inactive`, `admin.hub title`. Per-row type labels resolve via
`tRoot(meta.labelKey)` in the loader, as the native `recordTypeLabel` does.

## 3. Proposed conformance registry entry (coordinator: `scripts/viewspec-conformance.mjs`)

DB state verified read-only against `openbooks_sim_viewspec` on 127.0.0.1:55439
(`app.bypass_rls='on'`): the harness org (`viewspec@sim.test`,
org `da472d3a-…`) holds **25 `form_layouts`** (≈1 per record type, so the
default forms tab renders 25 rows on one page, `perPage: 100`) and **43
org-scope `list_views`**. Row content counts assume the harness user keeps
`admin.customization.manage` (I could not verify its role mapping read-only —
coordinator to confirm; if it lacks the permission the forms tab force-switches
to views and the back link disappears, which the variants below would catch as
a mismatch rather than silently pass).

```js
{
  path: '/admin/customization',
  // Forms tab (default): 25 seeded layouts on one page. Views tab: 43
  // org-scope views. Record-type filter: one layout per type. No-match search
  // asserts the views empty branch (forms tab has no empty treatment).
  variants: [
    '',
    '?tab=views',
    '?recordType=sales_order',
    '?recordType=sales_order&tab=views',
    { query: '?tab=views&q=zzzznomatch', expect: 'table thead th', minMatches: 1 },
  ],
  expect: 'table tbody tr',
  minMatches: 20,
},
```

Note: the `?tab=views&q=zzzznomatch` variant asserts the views EmptyState
branch renders *something* — tighten its `expect` to an empty-state selector
if the harness has one; I did not want to invent a selector. Drawer variants
(`?form=<id>`, `?view=<id>`) are omitted: the drawers are client components
whose open state depends on interactive `UrlDrawer` behaviour, same reason
other converted pages (api-keys, custom-fields) register only the default
variant despite having drawers. Sample form id in this org:
`01a083e6-dcb7-763f-a0e4-e9d9a02a2480`.

## 4b. Typecheck status — NOT run (read this before finishing)

`cd web && node_modules/.bin/tsc --noEmit -p tsconfig.json` could not be run:
this worktree has no `node_modules` (verified: `web/node_modules/.bin/tsc`
absent, as in sibling worktrees), a full install is ~1.1 GB on a shared disk
at 84.7% pressure, and the main checkout's `node_modules` cannot be borrowed
— its `packages/viewspec` + `web/components/viewspec` sources have diverged
from this worktree, so a foreign typecheck would prove nothing. **The
coordinator must typecheck before merging.** Mitigations done instead: every
`f()`/`rootF()`/`item()` path mechanically checked against
`CustomizationData`/`CustomizationFormRow`/`CustomizationViewRow` (no
dangling refs); the loader return read line-by-line against the interface
(all keys present, row mappings complete); imports verified against actual
exports (`customFieldTargetFor`, `defaultFormLayout`, `loadFieldDefs`,
`disabledRecordTypes`, `subsidiaryFeatureEnabled`, builder functions);
`openForm`/`openView` casts use `as unknown as …` (direct `as` from the
`db.execute` row type to the designer def type would fail for overlapping
but incompatible shapes — e.g. `layout: unknown` vs `FormLayoutConfig`).

## 5. Could not express (and why)

1. Tab strip, record-type `SearchSelectFilter`, docs outline+icon button,
   NewForm/NewView buttons, both designer drawers — no registry entries (see
   §1). These are all whole interactive components; none calls for new
   block/cell vocabulary.
2. Views-tab `EmptyState` action button — needs the `actionProps`
   forward in §1; without it the button renders with an empty record type.
3. Right-aligned duplicate-link column — `column(align: 'right')` presumably
   covers it, but no converted page precedent right-aligns a body cell via the
   spec (api-keys used `headerClassName` for its actions column); flagging for
   the harness to confirm rather than assuming.
