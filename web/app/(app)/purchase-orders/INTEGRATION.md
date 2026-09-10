# INTEGRATION — `/purchase-orders` ViewSpec conversion

Page: `web/app/(app)/purchase-orders/page.tsx`.
Status: **converted, pending vocabulary.** `view.ts` and the `__viewspec`
branch in `page.tsx` are written; no `sections.tsx` (the page has no composite
cells — every cell lives inside the shared `RecordListView`). The spec
references widget names proposed below, which do not exist in
`WIDGET_REGISTRY` yet. Until the coordinator registers them, the
`?__viewspec=1` path throws `UnknownWidgetError` at render — the native
branch is untouched and ships.

No `packages/viewspec` language change is needed. The one structural need is
a `record-list-view` slot beside `entity-list-view`: `RecordListView` takes
`orgId`/`userId` capability objects plus live query state, so — exactly like
`EntityListSlot` — the slot re-derives auth server-side and the spec supplies
only the record type, base path, current params, and widget refs.

## 1. Proposed `WIDGET_REGISTRY` entries (coordinator: `web/components/viewspec/widgets.tsx`)

```tsx
import { RecordListView } from '../record-list-view'
import { NewOrderButton } from '../../app/(app)/_order/NewOrderButton'
import { NewOrderRedirect } from '../../app/(app)/_order/NewOrderRedirect'
import { OrderDrawer } from '../../app/(app)/_order/OrderDrawer'

// The universal documents list. `drawer` and `emptyAction` name widgets
// rather than carrying components — identical indirection to
// `entity-list-view` (which additionally passes `sp` straight through).
// `drawer` accepts ONE widget ref or a LIST of them: this page's slot holds
// the create-redirect then the order flyout, in that order (the projects
// precedent: redirect, record flyout, transaction flyout).
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
      drawer={slot(props.drawer)}
      emptyAction={slot(props.emptyAction)}
    />
  )
},

// New-draft button + create-redirect. Whole-component passthroughs; every
// prop arrives loader-resolved (labels pre-translated, like the native page
// does before rendering). `NewOrderButton`/`NewOrderRedirect` are shared by
// all four order pages (estimates, sales orders, purchase orders, plus the
// transfer page that reuses them), so these entries serve the other three
// conversions too.
'new-order': (props) => (
  <NewOrderButton
    apiPath={str(props, 'apiPath') ?? ''}
    base={str(props, 'base') ?? ''}
    param={str(props, 'param') ?? ''}
    label={str(props, 'label') ?? ''}
    createFailedMessage={str(props, 'createFailedMessage') ?? ''}
  />
),
'new-order-redirect': (props) => (
  <NewOrderRedirect
    apiPath={str(props, 'apiPath') ?? ''}
    base={str(props, 'base') ?? ''}
    param={str(props, 'param') ?? ''}
    createFailedMessage={str(props, 'createFailedMessage') ?? ''}
  />
),

// Order flyout. Whole-component passthrough with the drawer's remount key,
// exactly like `account-drawer` (the drawer holds unsaved form state, so the
// key must survive — `key={doc.id}` in the native page).
'order-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof OrderDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <OrderDrawer key={remountKey} {...rest} />
},
```

And the slot itself (coordinator: `web/components/viewspec/record-list-slot.tsx`,
beside `entity-list-slot.tsx`):

```tsx
import 'server-only'

import type { ReactNode } from 'react'
import { can, getAuthz } from '../../lib/authz'
import { RecordListView } from '../record-list-view'

/**
 * Slot for the universal documents list.
 *
 * `RecordListView` needs an org id, a user id and the live query state. None
 * of those may travel through a spec: a spec is data, and data that names an
 * org id is a cross-tenant read waiting to happen. So the slot re-derives
 * auth from the session — the spec supplies only the record type, the base
 * path, and the URL it was already rendering with.
 *
 * `drawer` and `emptyAction` are components, so the spec names widgets and
 * the caller resolves them, the same indirection the empty state uses for
 * its action button.
 */
export async function RecordListSlot({
  recordType,
  basePath,
  sp,
  drawer,
  emptyAction,
}: {
  recordType: string
  basePath: string
  sp: Record<string, string | string[] | undefined>
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
    />
  )
}
```

Note: the native page computes `canManage` for the LIST as
`can(authz, 'admin.customization.manage')` (designer access), while the New
button gates on `ap.create`. Both decisions stay in their owners: the list
permission is re-derived inside the slot (as above), and the button/redirect
visibility (`canManage` in `PurchaseOrdersData`) gates only widget placement
via `when` — mirroring how the native page conditionally renders `newBtn`.

## 2. Spec notes (`view.ts` as written)

- Loader copies the native drawer assembly verbatim (`loadOrder` + the nine
  pickers, `resolveFormLayout`, the subsidiary depth-prefix mapping). Two
  deliberate deltas, both presentation-shaping the loader owns: the drawer
  payload is nested under `drawer` with a `remountKey` (accounts precedent),
  and `openId === 'new' && canManage` becomes the `showNewRedirect` presence
  flag.
- `subsidiaryUiOptions` rows are filtered+mapped in the loader exactly as the
  native page does (allowed-subsidiary restriction + depth indent); the result
  is plain data before it reaches the drawer props.
- No table/sorting/pagination blocks: the list chrome (search, filters,
  sortable columns, pager) lives inside `RecordListView` and renders
  identically on both paths because it IS the same component.
- No message-key risk: every `t()` call is copied from the native page
  (`purchaseOrders:list.title`, `list.description`, `list.newButton`,
  `list.createDraftFailed` — all verified in
  `web/messages/en/purchaseOrders.json`).

## 3. Fixtures + conformance (coordinator: `scripts/viewspec-fixtures.sql`, `scripts/viewspec-conformance.mjs`)

The sim tenant holds **zero `purchase_order` documents** (verified read-only;
`vendor_bill` has 238), so the harness would refuse the page. Seed two rows —
insert order verified in a rolled-back transaction (draft status required:
a `document_line_immutability_guard()` trigger rejects line inserts once the
doc leaves draft):

```sql
-- ---- purchase orders -------------------------------------------------------
--
-- The simulator never creates purchase orders, so the list page is empty and
-- the harness refuses it. Two drafts (draft status: the line-immutability
-- trigger rejects line inserts on non-draft docs), distinct vendors, one line
-- each against live sim items/accounts.
insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status, subtotal, tax_total, total)
values
  ('00000000-0000-7000-9000-000000000401', v_org, 'purchase_order', 'PO-000001', '71344e26-f286-4661-9d81-0f2a976cf5c5', current_date - 5, 'USD', 'draft', 1500, 0, 1500),
  ('00000000-0000-7000-9000-000000000402', v_org, 'purchase_order', 'PO-000002', '96c6a13b-5ae5-4627-b56a-1fc2c5bec9fc', current_date - 2, 'USD', 'draft', 750, 0, 750)
on conflict (id) do nothing;
insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit_price, amount)
values
  ('00000000-0000-7000-9000-000000000411', v_org, '00000000-0000-7000-9000-000000000401', 1, '7f1ebdf1-28da-417c-9ed8-73fa1822c07b', 'a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e', 'Field labor', 10, 150, 1500),
  ('00000000-0000-7000-9000-000000000412', v_org, '00000000-0000-7000-9000-000000000402', 1, '7f1ebdf1-28da-417c-9ed8-73fa1822c07b', 'a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e', 'Field labor', 5, 150, 750)
on conflict (id) do nothing;
```

The referenced parties/items/accounts are live sim rows (two active vendors,
the "Field Labor (T&M)" service item, the 1010 operating account); `v_org`
follows the fixtures file's existing pattern (SIM org lookup). A PO form
layout ("Default form", `01a083e6-dcbd-7078-94f6-ee13d93a63bc) is already
seeded, so the drawer resolves its layout with no extra fixture.

```js
{
  path: '/purchase-orders',
  // Two fixture drafts. The drawer variant names the drawer layer (UrlDrawer
  // flyout, portaled to <body>).
  variants: [
    '',
    {
      query: '?order=00000000-0000-7000-9000-000000000401',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

`minMatches: 2` verified: exactly the two fixture rows (zero in sim today).
The harness user is super-admin with `orders` default-on, so both gates pass.

## 4. Typecheck status

`cd web && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`: exit 0, zero
errors — including the previously-reported dangling registry imports, which
the merge restored. Clean for `purchase-orders/` and the repo.

## 5. Could not express (and why)

1. The `RecordListView` shell itself — it owns queries, saved-view
   resolution, filter chips, sortable columns and pagination internally, all
   driven by capability objects. Decomposing it into blocks would reimplement
   it badly; the `record-list-view` slot is the accounts-page answer to the
   same problem. No new block/cell vocabulary.
2. Drawer `userId`/`canManage`/subsidiary-visibility: these arrive inside the
   drawer payload built by the loader from the session, or re-derived inside
   the slot — never as spec-addressable fields. Flagging for the record since
   the slot doc states the rule explicitly.
