# /ap/bills ViewSpec integration handoff

The spec in `view.ts` needs FOUR registry entries the coordinator owns
(`web/components/viewspec/widgets.tsx`) plus one NEW shared slot file. This
page renders through `RecordListView`, and no slot exists for it yet — unlike
`EntityListView`, which `entity-list-slot.tsx` already covers.

## 1. New shared slot: `web/components/viewspec/record-list-slot.tsx` (coordinator creates)

`RecordListView` needs `orgId`, `userId`, a permission decision
(`canManage`), and a per-row actions renderer (`renderRowActions`). The first
three are capabilities that must be re-derived server-side, mirroring
`entity-list-slot.tsx` exactly. The fourth is a component: for document lists
the renderer is always a `DocumentRowActions` for that row's kind, so the slot
can own it the way `EntityListSlot` owns nothing — the only per-page inputs
are `recordType`, `basePath`, and the drawer-param key.

```tsx
import 'server-only'

import type { ReactNode } from 'react'
import { can, getAuthz } from '../../lib/authz'
import { RecordListView } from '../record-list-view'
import { DocumentRowActions } from '../document-row-actions'
import { DOC_KINDS } from '../../lib/document-kinds'
import { buildListDrawerHref } from '../../lib/list-params'

/**
 * Slot for the universal record list (bills, invoices, orders, …).
 *
 * Same contract as EntityListSlot: org id, user id and the permission
 * decision are re-derived from the session — a spec that could name an org id
 * is a cross-tenant read. `drawer` and `emptyAction` are resolved widgets,
 * the same indirection the empty state uses.
 *
 * `rowActions` selects the per-row `_actions` cell. Document lists render a
 * `DocumentRowActions` for the row's own kind (submit/post/open); lists with
 * bespoke actions (payroll runs link out, banking transactions open a
 * different drawer) keep their native component until a slot covers them, so
 * the prop is a closed string, not a component reference:
 *   - 'document' — DocumentRowActions with DOC_KINDS[row.kind]
 *   - 'none'     — no renderRowActions (default eye-link cell)
 */
export async function RecordListSlot({
  recordType,
  basePath,
  sp,
  drawerParam,
  rowActions = 'none',
  drawer,
  emptyAction,
}: {
  recordType: string
  basePath: string
  sp: Record<string, string | string[] | undefined>
  drawerParam: string
  rowActions?: 'document' | 'none'
  drawer?: ReactNode
  emptyAction?: ReactNode
}) {
  const authz = await getAuthz()
  if (!authz) return null
  return (
    <RecordListView
      recordType={recordType}
      basePath={basePath}
      orgId={authz.user.orgId}
      userId={authz.user.id}
      canManage={can(authz, 'admin.customization.manage')}
      sp={sp}
      drawer={drawer}
      emptyAction={emptyAction}
      renderRowActions={
        rowActions === 'document'
          ? (row) => (
              <DocumentRowActions
                id={row.id}
                status={row.status}
                config={DOC_KINDS[row.kind]!}
                openHref={buildListDrawerHref(basePath, sp, drawerParam, row.id)}
              />
            )
          : undefined
      }
    />
  )
}
```

`/ap/bills` passes `rowActions: 'document'`, `drawerParam: 'doc'` — reproducing
its native `renderRowActions` bit for bit (the native page builds the same
`openHref` as `/ap/bills?doc=${row.id}`; `buildListDrawerHref` with no extra
params returns exactly that, and also preserves any active filters the way the
list's own reference cells already do). `/ar/invoices` passes the same pair
with its own basePath. Expense reports, banking transactions and payroll runs
pass `rowActions: 'none'` today (their custom renderers stay native-only until
a slot covers them — see §4).

## 2. `WIDGET_REGISTRY` entries (coordinator adds)

```tsx
/* --- ap bills ------------------------------------------------------------- */
'ap-capture-link': (props) => (
  <Button asChild variant="outline">
    <Link href={(str(props, 'href') ?? '/ap/capture') as never}>
      <ScanLine size={14} aria-hidden />
      {str(props, 'label') ?? ''}
    </Link>
  </Button>
),
```

Byte-equivalence notes (checked against `page.tsx` lines 74–76):

- `Button variant="outline" asChild` + `Link` child: identical element tree to
  the native `headerActions`.
- `ScanLine size={14}`: the native icon has no `aria-hidden`; lucide sets
  `aria-hidden="true"` by default on every svg, so both renders carry it. No
  whitespace text node between icon and label in either (JSX trims the
  line-break boundary the same way in both files).
- The wrapping `<div className="flex items-center gap-2">` is NOT a widget —
  it arrives via the header block's `actionsClassName`, which `blocks.tsx`
  renders as a plain div around the actions slot (same as the native
  `headerActions` div).

```tsx
'new-ap-bill': (props) => (
  <NewDocumentButton
    items={(props.items as ComponentProps<typeof NewDocumentButton>['items']) ?? []}
    basePath={str(props, 'basePath') ?? ''}
    triggerLabel={str(props, 'triggerLabel') ?? ''}
    creatingLabel={str(props, 'creatingLabel') ?? ''}
    failedLabel={str(props, 'failedLabel') ?? ''}
  />
),
```

- Props are loader-resolved strings (`t('actions.newBill')`,
  `tCommon('actions.creating')`, `t('toasts.createDraftFailed')`); the two
  `newItems` labels come from `t('actions.newBill')` /
  `t('actions.newCredit') ?? t('actions.newBill')`. All four keys are already
  used by the native page. The spec places this widget twice (header actions
  gated on `canCreate`, empty-state action) — the same `newButton` element the
  native page passes as both `headerActions` child and `emptyAction`. Both
  placements instantiate the component twice in the native render too (header
  + empty state), so hook state is per-placement in both paths.
- Needs imports: `NewDocumentButton`, `ScanLine`, `Button`, `Link`.

```tsx
'ap-bill-drawer': (props) => {
  const drawer = props.drawer as (Omit<
    ComponentProps<typeof DocumentDrawer>,
    'payload' | 'config' | 'layout' | 'availableLayouts'
  > & {
    remountKey: string
    payload: unknown
    config: unknown
    layout: unknown
    availableLayouts: unknown
  }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return (
    <DocumentDrawer
      key={remountKey}
      basePath="/ap/bills"
      {...(rest as ComponentProps<typeof DocumentDrawer>)}
    />
  )
},
```

- The remount key rides as a prop (`key={openDoc.doc.id}` natively), the same
  arrangement as `party-drawer`/`account-drawer`.
- `DOC_KINDS[openKind]!` (`DocKindConfig`) is plain client-safe data
  (`web/lib/document-kinds.ts` header: "Kept free of any server-only imports
  … so it can be bundled for the browser"), so it travels as drawer data, not
  a capability. Same for `resolvedForm.layout` / `.available`
  (plain JSON layout configs) and all picker `Opt[]` arrays.
- `initialMode` is loader-resolved (`pickString(sp.mode) === 'edit'`).
- `basePath="/ap/bills"` is a literal in the widget, matching the native
  `basePath="/ap/bills"` prop — it is routing config the page already names,
  not a capability.

```tsx
'record-list-view': (props) => {
  const one = (value: unknown, key: number) => {
    if (!value || typeof value !== 'object') return null
    const ref = value as { widget?: string; props?: Record<string, unknown> }
    const renderer = ref.widget ? WIDGET_REGISTRY[ref.widget] : undefined
    if (ref.widget && !renderer) throw new UnknownWidgetError(ref.widget)
    return renderer ? <Fragment key={key}>{renderer(ref.props ?? {})}</Fragment> : null
  }
  const slot = (value: unknown) => {
    if (Array.isArray(value)) {
      const rendered = value.map(one).filter(Boolean)
      return rendered.length > 0 ? <>{rendered}</> : undefined
    }
    return one(value, 0) ?? undefined
  }
  return (
    <RecordListSlot
      recordType={str(props, 'recordType') ?? ''}
      basePath={str(props, 'basePath') ?? ''}
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      drawerParam={str(props, 'drawerParam') ?? 'doc'}
      rowActions={str(props, 'rowActions') === 'document' ? 'document' : 'none'}
      drawer={slot(props.drawer)}
      emptyAction={slot(props.emptyAction)}
    />
  )
},
```

- Copy of the `entity-list-view` entry with `basePath`/`drawerParam`/
  `rowActions` added (all plain strings the page already names). The drawer/
  emptyAction list-of-widgets handling is verbatim.
- This page's spec passes `drawerParam: 'doc'`, `rowActions: 'document'`
  explicitly — without `rowActions: 'document'` the actions column would
  silently degrade to the default eye-link cell.

## 3. Proposed conformance registry entry

Verified against `openbooks_sim_viewspec` (bypass RLS). The harness user
`viewspec@sim.test` belongs to org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`,
which holds **238 `vendor_bill` + 0 `vendor_credit`** documents, all with
`subsidiary_id` null (no subsidiary scoping in play) and statuses spanning at
least `posted` + more (`posted` count is 238 of 238 — the status chip branch
still renders because `statusCounts` always yields ≥1 option; the kind chips
render both kinds with credit count 0).

```js
{
  path: '/ap/bills',
  variants: [
    '',
    // Status filter branch (posted is the dominant status in fixtures).
    '?status=posted',
    // Deliberate empty result: asserts the empty branch (generic
    // common.empty.* copy + the New button as emptyAction), not row content.
    '?q=zzzznomatch',
    // The flyout is portaled to <body>: without naming that root the
    // comparison never looks at the drawer at all (same hole the admin
    // pages closed). Doc is a posted vendor_bill in the harness org.
    {
      query: '?doc=01a083e7-391c-7a04-886f-9bf4cb26b71b',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

- Default `perPage` is 25 (saved-view default), so `table tbody tr` matches 25
  rows on the default variant; `minMatches: 3` stays robust to fixture drift.
- Vendor-credit coverage: zero `vendor_credit` rows exist in fixtures, so the
  credit kind chip (count 0) and any credit drawer are unasserted. If the
  coordinator's fixture pass adds a credit, add `?kind=vendor_credit` and a
  credit-drawer variant.
- `?status=posted` returns all 238 rows paginated — a real filtered branch,
  not a duplicate of default.

## 4. What could not be expressed

1. **`RecordListView` has no slot.** The spec names `record-list-view`, which
   does not exist in `WIDGET_REGISTRY` yet — §1+§2 is the exact proposal.
   Nothing about the list itself (columns, sorts, counts, pagination) is
   re-expressed: it stays one host component, placed by name.
2. **Custom `renderRowActions` elsewhere.** Banking transactions, expense
   reports and payroll runs pass bespoke renderers that are components, not
   data; the proposed slot covers them with `rowActions: 'none'` (default
   eye-link) and their conversions must either extend the closed union or keep
   those lists native. Bills/invoices need only `'document'`.
3. **No new vocabulary needed.** Header actions (`pageHeader` +
   `actionsClassName`), the capture link (plain `Button asChild` + icon —
   same shape as `docs-link-button`), presence-gated widgets, and the
   remount-key drawer all already exist as patterns. No `packages/viewspec`
   changes proposed.
4. **`drawerOpen` in `ApBillsData` is load-bearing documentation only.**
   The native page renders the drawer element only when open; through the slot
   that falls out of `drawer: null`. The flag is kept so the loader's
   drawer-open decision stays greppable, matching the parties `drawerOpen`
   field.
