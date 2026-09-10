# /estimates ViewSpec integration handoff

The spec in `view.ts` needs THREE registry entries the coordinator owns
(`web/components/viewspec/widgets.tsx`) plus the shared `record-list-view`
machinery. Like `/ap/bills`, this page renders through `RecordListView`
(`recordType: 'quote'`), and no slot exists for it yet — the `entity-list-view`
widget only covers `EntityListView`, which has no `quote` source.

## 1. `WIDGET_REGISTRY` entries (coordinator adds)

```tsx
/* --- estimates (shared _order components: sales-orders + purchase-orders reuse) --- */
'new-estimate-order': (props) => (
  <NewOrderButton
    apiPath={str(props, 'apiPath') ?? ''}
    base={str(props, 'base') ?? ''}
    param={str(props, 'param') ?? ''}
    label={str(props, 'label') ?? ''}
    createFailedMessage={str(props, 'createFailedMessage') ?? ''}
  />
),
'new-estimate-order-redirect': (props) => (
  <NewOrderRedirect
    apiPath={str(props, 'apiPath') ?? ''}
    base={str(props, 'base') ?? ''}
    param={str(props, 'param') ?? ''}
    createFailedMessage={str(props, 'createFailedMessage') ?? ''}
  />
),
'estimate-order-drawer': (props) => {
  const drawer = props.drawer as (Omit<
    ComponentProps<typeof OrderDrawer>,
    'order' | 'parties' | 'accounts' | 'items' | 'taxCodes' | 'taxGroups' | 'departments' | 'projects' | 'segments' | 'subsidiaries' | 'layout'
  > & {
    remountKey: string
    order: unknown
    parties: unknown
    accounts: unknown
    items: unknown
    taxCodes: unknown
    taxGroups: unknown
    departments: unknown
    projects: unknown
    segments: unknown
    subsidiaries: unknown
    layout: unknown
  }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <OrderDrawer key={remountKey} {...(rest as ComponentProps<typeof OrderDrawer>)} />
},
```

With imports (paths from `web/components/viewspec/`):

```tsx
import { NewOrderButton } from '../../app/(app)/_order/NewOrderButton'
import { NewOrderRedirect } from '../../app/(app)/_order/NewOrderRedirect'
import { OrderDrawer } from '../../app/(app)/_order/OrderDrawer'
```

Byte-equivalence notes (checked against `estimates/page.tsx`):

- `NewOrderButton apiPath="/api/estimates" base="/estimates" param="estimate"`
  plus loader-resolved labels (`estimates:list.newButton`,
  `estimates:list.createDraftFailed`). All three keys are already used by the
  native page. The spec places this widget twice (header actions gated on
  `canManage`, empty-state action) — the same `newBtn` element the native page
  passes as both `actions` and `emptyAction`. Both placements instantiate the
  component twice in the native render too, so hook state is per-placement in
  both paths.
- `NewOrderRedirect` renders `null` and fires once via `useEffect`; the spec
  includes it in the drawer widget list only when `showNewRedirect` is true
  (`openId === 'new' && canManage`), resolved in the loader because nested
  drawer refs do not evaluate `when` (the slot's `one()` ignores it — same
  reason every sibling page pushes presence into loader-resolved data).
- `subsidiaries` arrive pre-filtered and pre-indented
  (`` `${'  '.repeat(depth ?? 0)}${name}` ``) from the loader — the native
  page's `.filter().map()` chain copied verbatim, since a spec cannot map.
- The remount key rides as a prop (`key={drawerOrder.doc.id}` natively), the
  same arrangement as `party-drawer`/`account-drawer`/`ap-bill-drawer`.
- `initialMode` is loader-resolved (`pickString(sp.mode) === 'edit'`).
- `layout` is `resolvedForm?.layout` (undefined when no flyout is open — the
  drawer widget is only placed then) or the resolved `FormLayoutConfig` (plain
  JSON from the `form_layouts` table). All picker arrays are plain DB rows.

## 3. Proposed conformance registry entry

The sim tenant holds **zero** `quote` documents (`select kind, count(*)`
over the harness org returns no `quote` row at all out of 925 documents), so
the harness would reject this page without fixtures. The SQL below seeds three
draft quotes plus line rows for one of them; the drawer variant opens the
first. Verified preconditions: the parties exist as active customers in the
harness org (`Harborview Development LLC`, `Municipal School District #7`,
`Northgate Industrial REIT`), and the `orders` feature defaults on (the org
sets no override, and `feature-registry.ts` marks `orders` `defaultEnabled`).

```js
{
  path: '/estimates',
  variants: [
    '',
    // Deliberate empty result: asserts the generic common.empty.* copy plus
    // the New button as emptyAction, not row content.
    '?q=zzzznomatch',
    // The flyout is portaled to <body>: without naming that root the
    // comparison never looks at the drawer at all.
    {
      query: '?estimate=00000000-0000-7000-9000-000000000401',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

## 4. Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed ids, `ON CONFLICT DO NOTHING`, SIM org only (same `v_org`
pattern as the existing blocks):

```sql
  -- ---- estimates -----------------------------------------------------------
  -- The simulator never writes quotes, so the list page would compare two
  -- identical empty states. Three drafts (one with lines, for the drawer
  -- variant) in the SIM org.
  insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status, subtotal, tax_total, total, memo)
  values
    ('00000000-0000-7000-9000-000000000401', v_org, 'quote', 'EST-VIEWSPEC-1',
     (select id from parties where org_id = v_org and display_name = 'Harborview Development LLC' limit 1),
     current_date - interval '6 days', 'USD', 'draft', 5000, 0, 5000, 'ViewSpec harness quote one'),
    ('00000000-0000-7000-9000-000000000402', v_org, 'quote', 'EST-VIEWSPEC-2',
     (select id from parties where org_id = v_org and display_name = 'Municipal School District #7' limit 1),
     current_date - interval '3 days', 'USD', 'draft', 12000, 0, 12000, 'ViewSpec harness quote two'),
    ('00000000-0000-7000-9000-000000000403', v_org, 'quote', 'EST-VIEWSPEC-3',
     (select id from parties where org_id = v_org and display_name = 'Northgate Industrial REIT' limit 1),
     current_date - interval '1 day', 'USD', 'approved', 8000, 0, 8000, 'ViewSpec harness quote three')
  on conflict (id) do nothing;

  insert into document_lines (document_id, org_id, line_number, description, quantity, unit_price, amount)
  values
    ('00000000-0000-7000-9000-000000000401', v_org, 1, 'Harness line one', 10, 300, 3000),
    ('00000000-0000-7000-9000-000000000401', v_org, 2, 'Harness line two', 4, 500, 2000)
  on conflict do nothing;
```

- Statuses span `draft` + `approved`, so the status filter chips render with
  real counts on the default variant (3 rows ⇒ `minMatches: 3` verified once
  fixtures land).
- The `?estimate=<id>` drawer variant needs only the document row (the drawer
  renders header pickers from live org data); the two line rows exercise the
  drawer's line grid on the same variant.
- `document_lines` conflict target: use whatever unique constraint the table
  carries (`on conflict do nothing` without a target is valid Postgres and
  matches the "idempotent" file contract — adjust to the table's actual
  constraint if the harness lint requires an explicit target).

## 5. What could not be expressed

1. **`RecordListView` has no slot.** The spec names `record-list-view`,
   which does not exist in `WIDGET_REGISTRY` yet — §2 is the exact proposal
   (identical to the `/ap/bills` handoff, plus the `drawerParam`-uniformity
   and absent-`rowActions` notes above). Nothing about the list itself
   (columns, sorts, counts, pagination) is re-expressed.
2. **No new vocabulary needed.** Header actions (`pageHeader` + conditional
   widget), the remount-key drawer, and the two-widget drawer list (redirect +
   flyout, mirroring the projects precedent) all already exist as patterns.
   No `packages/viewspec` changes proposed. The three coordinator cautions do
   not trigger here: no native `<section>` (the list owns its markup), no
   `tabular-nums` `<td>` in page-owned markup, no page-owned pager.
3. **`drawerOrder` cast.** The native page does `openOrder as unknown as
   OrderDrawerProps['order'] | null`; the loader keeps the same cast into the
   drawer payload (verbatim semantics, same deliberate unsafety).

## 2. Shared `record-list-view` machinery (coordinator owns; same proposal as /ap/bills)

This page needs the identical `record-list-view` widget +
`web/components/viewspec/record-list-slot.tsx` proposed in
`web/app/(app)/ap/bills/INTEGRATION.md` §1–§2 (slot re-derives `orgId`,
`userId`, `canManage` from the session; resolves `drawer`/`emptyAction`
widget refs including lists; `rowActions: 'document'` renders per-row
`DocumentRowActions`). Estimates passes `recordType: 'quote'`,
`basePath: '/estimates'`, `drawerParam: 'estimate'`, `rowActions: 'document'`.

Two estimates-specific notes for the slot author:

- The `quote` source (`web/lib/list/sources.ts:184`) is
  `kinds: ['quote']`, `drawerParam: 'estimate'`, `partyRole: 'customer'` —
  single-kind, so no kind chips render (unlike the multi-kind AP list).
- This page passes **no** `renderRowActions` natively, so the `_actions`
  column uses the list's default eye-link cell
  (`buildListDrawerHref(basePath, sp, 'estimate', row.id)`, built inside
  `RecordListView` itself). This spec therefore omits the `rowActions` prop
  entirely (absent ⇒ default cell, byte-identical to native) but still passes
  `drawerParam: 'estimate'` so the `record-list-view` widget contract stays
  uniform across pages. The slot must treat a missing `rowActions` as
  "no custom renderer", not as `'document'`.
