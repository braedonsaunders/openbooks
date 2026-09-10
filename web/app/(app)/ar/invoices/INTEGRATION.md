# /ar/invoices ViewSpec integration handoff

Page: `web/app/(app)/ar/invoices/` — owner files are `view.ts` (+ this file)
and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`: the
page needs no composite cells (see "What the spec does NOT cover" below).

Spec widgets used: `pageHeader` block + `new-ar-document`,
`record-list-view`, `ar-document-drawer`, `ar-document-row-actions`
(all four proposed below — none exist in the registry yet).

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed (all already exist as components):

```tsx
import { RecordListSlot } from './record-list-slot' // proposed new file, see §2
import { DocumentDrawer } from '../../components/document-drawer'
import { DocumentRowActions } from '../../components/document-row-actions'
import { NewDocumentButton } from '../../components/new-document-button'
import { PaymentLinksPanel } from '../../components/payment-links-panel'
import { DOC_KINDS } from '../../lib/document-kinds'
```

Entries:

```tsx
/* --- AR invoices -------------------------------------------------------- */
'new-ar-document': (props) => (
  <NewDocumentButton
    items={(props.items as ComponentProps<typeof NewDocumentButton>['items']) ?? []}
    basePath={str(props, 'basePath') ?? ''}
    triggerLabel={str(props, 'triggerLabel') ?? ''}
    creatingLabel={str(props, 'creatingLabel') ?? ''}
    failedLabel={str(props, 'failedLabel') ?? ''}
  />
),
/**
 * The universal record list. `drawer` and `emptyAction` name widgets rather
 * than carrying components — a spec cannot express JSX, so the indirection is
 * the same one the empty state already uses for its action. `rowActions`
 * names ONE widget rendered per row for the `_actions` column; the slot
 * builds `renderRowActions` from it. The widget receives the row's `id`,
 * `status` and `kind` plus the static props from the ref.
 */
'record-list-view': (props) => {
  const slot = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined
    const ref = value as { widget?: string; props?: Record<string, unknown> }
    const renderer = ref.widget ? WIDGET_REGISTRY[ref.widget] : undefined
    if (ref.widget && !renderer) throw new UnknownWidgetError(ref.widget)
    return renderer ? renderer(ref.props ?? {}) : undefined
  }
  const rowActionsRef =
    props.rowActions && typeof props.rowActions === 'object'
      ? (props.rowActions as { widget?: string; props?: Record<string, unknown> })
      : undefined
  const rowActionsRenderer = rowActionsRef?.widget ? WIDGET_REGISTRY[rowActionsRef.widget] : undefined
  if (rowActionsRef?.widget && !rowActionsRenderer) throw new UnknownWidgetError(rowActionsRef.widget)
  return (
    <RecordListSlot
      recordType={str(props, 'recordType') ?? ''}
      basePath={str(props, 'basePath') ?? ''}
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      drawer={slot(props.drawer)}
      emptyAction={slot(props.emptyAction)}
      renderRowActions={
        rowActionsRenderer
          ? (row) =>
              rowActionsRenderer({
                ...(rowActionsRef?.props ?? {}),
                id: row.id,
                status: row.status,
                kind: row.kind,
              })
          : undefined
      }
    />
  )
},
/** The remount key rides along as a prop: switching documents must reset the
 *  drawer's client state, and a widget at a fixed position would otherwise
 *  be reused (same pattern as `account-drawer` / `party-drawer`). */
'ar-document-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof DocumentDrawer> & {
    remountKey: string
    paymentLinks: { documentId: string; canManage: boolean } | null
  }) | null
  if (!drawer) return null
  const { remountKey, paymentLinks, ...rest } = drawer
  return (
    <DocumentDrawer
      key={remountKey}
      {...rest}
      afterContent={
        paymentLinks ? (
          <PaymentLinksPanel documentId={paymentLinks.documentId} canManage={paymentLinks.canManage} />
        ) : null
      }
    />
  )
},
/**
 * Per-row invoice actions. `config` is re-derived here from the row's `kind`
 * via the static DOC_KINDS map — the loader never ships it as data (it is a
 * registry lookup, and the drawer entry shows the same treatment).
 */
'ar-document-row-actions': (props) => (
  <DocumentRowActions
    id={String(props.id ?? '')}
    status={String(props.status ?? '')}
    config={DOC_KINDS[String(props.kind ?? '')]!}
    openHref={`${str(props, 'basePath') ?? ''}?doc=${String(props.id ?? '')}`}
  />
),
```

Why four entries and not one: `new-ar-document` is the header action AND the
list empty action (the native page passes the same `newButton` to both, so the
spec references the same widget ref twice). The drawer and the row actions are
separate widgets because they render in different slots with different data.

## 2. New shared slot (for the coordinator — `web/components/viewspec/record-list-slot.tsx`)

The `entity-list-view` widget's slot file (`entity-list-slot.tsx`) was removed
in 9e62fbad2 while the widget entry that imports it remains, so the tree does
not typecheck there (pre-existing, not mine — see §5). The record-list
equivalent does not exist yet either. Proposed shape, mirroring the removed
slot's doctrine (spec must never carry a capability or an org id):

```tsx
import 'server-only'

import type { ReactNode } from 'react'
import { can, getAuthz } from '../../lib/authz'
import { RecordListView } from '../record-list-view'

/**
 * Slot for the universal record list.
 *
 * `RecordListView` needs an org id, a user id and a permission decision. None
 * of those may travel through a spec: a spec is data, and data that names an
 * org id is a cross-tenant read waiting to happen. So the slot re-derives all
 * three from the session — the spec supplies only the record type, the base
 * path, and the URL it was already rendering with.
 *
 * `drawer` and `emptyAction` are components, so the spec names widgets and the
 * caller resolves them, the same indirection the empty state uses for its
 * action button. `renderRowActions` is a function, so the registry entry
 * builds it from the `rowActions` widget ref instead.
 */
export async function RecordListSlot({
  recordType,
  basePath,
  sp,
  drawer,
  emptyAction,
  renderRowActions,
}: {
  recordType: string
  basePath: string
  sp: Record<string, string | string[] | undefined>
  drawer?: ReactNode
  emptyAction?: ReactNode
  renderRowActions?: (row: any) => ReactNode
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
      renderRowActions={renderRowActions}
    />
  )
}
```

Note: `RecordListView` reads `sp.view` (saved-view id), `sp.status`,
`sp.kind`, `sp.from/to`, quick-filter params, sort and page from the search
params it is given — all plain strings, safe as spec data. The `__viewspec=1`
param rides along in `sp`; the conformance harness already strips it from
comparisons (viewspec-conformance.mjs `normalize`).

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (all 42 AR docs belong to the
harness org `da472d3a-…`; the harness user is `viewspec@sim.test` in that
org; the saved `customer_invoice` org-default view sorts by `document_date`
desc, 25/page, with a `_actions` column):

```js
{
  path: '/ar/invoices',
  // The universal record list + the document flyout. The default render
  // carries 42 posted invoices (25 on page one); the kind variant pins the
  // (currently empty) credit side; the drawer variant opens a real posted
  // invoice with its pickers, form layout and payment-links panel.
  variants: [
    '',
    { query: '?kind=customer_credit', expect: 'table thead th', minMatches: 1 },
    {
      query: '?doc=01a083e7-39a0-7f05-b0b9-db3149d75113',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      // The flyout is portaled to <body>, so it has to be named explicitly
      // or the comparison never looks at it.
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 25,
},
```

Row-count verification (read-only queries):

- `select kind, status, count(*) … where kind in
  ('customer_invoice','customer_credit')` → `customer_invoice|posted|42`
  (no credits in sim data, hence the thead-only credit variant).
- Drawer id `01a083e7-39a0-7f05-b0b9-db3149d75113` is `INV-00009`, posted,
  in the harness org — passes the org guard, and the subsidiary guard is
  vacuous: the harness user holds the admin role (`subsidiary_restriction`
  `{"mode": "all"}`), so `allowedSubsidiaryIds` is null.

## 4. What the spec does NOT cover (nothing — full coverage)

- No `sections.tsx`: the page defines no local components. `NewDocumentButton`,
  `DocumentRowActions`, `DocumentDrawer`, `PaymentLinksPanel` are all shared
  components, so the widgets reference them directly.
- The drawer `afterContent` conditional (payment links only on customer
  invoices with the feature on) is resolved in the LOADER to
  `paymentLinks: {…} | null` — presence, not branching.
- The New button's `canCreate` gate is `widget(…, f('canCreate'))` on the
  header action and `data.canCreate ? newDocument : null` on the empty action,
  matching the native `canCreate ? <NewDocumentButton/> : undefined` in both
  positions.
- The row-action `openHref` (`/ar/invoices?doc=<id>`) is rebuilt in the
  `ar-document-row-actions` entry from `basePath` + row id — byte-identical to
  the native template literal.

## 5. Pre-existing breakage in the merged base (not mine, not touched)

One pre-existing error remains on the untouched base, in a file I do not
own: `components/viewspec/widgets.tsx(62,35)` imports
`CustomizationTabs` from `web/app/(app)/admin/customization/sections`,
which does not exist (that dir holds `FormDesigner.tsx`,
`ListViewDesigner.tsx`, `page.tsx` — presumably another agent's conversion
in flight). My files (`ar/invoices/view.ts`, `ar/invoices/page.tsx`)
typecheck clean; the remaining error is not mine.
