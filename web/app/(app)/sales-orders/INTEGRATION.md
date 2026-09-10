# /sales-orders ViewSpec integration handoff

Page: `web/app/(app)/sales-orders/` — owner files are `view.ts` (+ this file)
and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`: the
page needs no composite cells (see §4).

Spec widgets used: `pageHeader` block + `new-sales-order`,
`new-sales-order-redirect`, `record-list-view`, `sales-order-drawer`
(all four proposed below — none exist in the registry yet).

Note: sales orders render through the universal `RecordListView` with NO
`renderRowActions` (unlike AR invoices), so this page needs no row-actions
widget — the slot's built-in eye-link fallback is the native render.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

Depends on the `record-list-view` widget + `RecordListSlot` proposed in
`web/app/(app)/ar/invoices/INTEGRATION.md` (§1–§2, already integrated and
harness-verified). New imports needed on top of those:

```tsx
import { OrderDrawer } from '../../app/(app)/_order/OrderDrawer'
import { NewOrderButton } from '../../app/(app)/_order/NewOrderButton'
import { NewOrderRedirect } from '../../app/(app)/_order/NewOrderRedirect'
```

Entries:

```tsx
/* --- sales orders --------------------------------------------------------- */
'new-sales-order': (props) => (
  <NewOrderButton
    apiPath={str(props, 'apiPath') ?? ''}
    base={str(props, 'base') ?? ''}
    param={str(props, 'param') ?? ''}
    label={str(props, 'label') ?? ''}
    createFailedMessage={str(props, 'createFailedMessage') ?? ''}
  />
),
/** `?<param>=new` deep link: mints the draft and swaps the URL to the real id. */
'new-sales-order-redirect': (props) => (
  <NewOrderRedirect
    apiPath={str(props, 'apiPath') ?? ''}
    base={str(props, 'base') ?? ''}
    param={str(props, 'param') ?? ''}
    createFailedMessage={str(props, 'createFailedMessage') ?? ''}
  />
),
/** The remount key rides along as a prop: switching orders must reset the
 *  drawer's client state, and a widget at a fixed position would otherwise
 *  be reused (same pattern as `account-drawer` / `document-drawer`). */
'sales-order-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof OrderDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <OrderDrawer key={remountKey} {...rest} />
},
```

`OrderDrawer` takes `kind` (`'sales_order'` literal, passed as loader data),
`initialMode`, pickers, `canManage`, `canOverrideCredit`, and
`layout?: FormLayoutConfig` — all plain data. No `afterContent` equivalent:
unlike `DocumentDrawer`, `OrderDrawer` has no kind-specific trailing section.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

The sim tenant has ZERO `sales_order` documents, so this page needs fixture
rows first (SQL in §3 — please fold into `scripts/viewspec-fixtures.sql`).
After fixtures, the entry:

```js
{
  path: '/sales-orders',
  // The universal record list + the order flyout. Three fixture orders
  // (two open, one converted) pin the table path; the drawer variant opens
  // a real order with its pickers and form layout.
  variants: [
    '',
    {
      query: '?order=00000000-0000-7000-9000-000000000401',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      // The flyout is portaled to <body>, so it has to be named explicitly
      // or the comparison never looks at it.
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

Row-count verification (read-only queries): `select kind, status, count(*) …
where kind = 'sales_order'` → zero rows today; the `minMatches: 3` above
counts the three fixture orders from §3 (all visible: `subsidiary_id` null,
harness user is admin with `subsidiary_restriction {"mode": "all"}`).

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Three `sales_order` documents in the SIM org (fixed ids, `ON CONFLICT DO
NOTHING`, same idempotent style as the existing file). Two open (one draft,
one confirmed) and one converted, so the status chips and the converted-link
branch both have rows. Amounts tie exactly: header `subtotal`/`total` equal
the line `amount` sums (untaxed lines, so `tax_total = 0`).

```sql
  -- ---- sales orders ----------------------------------------------------------
  --
  -- The simulator never writes sales orders, so the /sales-orders list is
  -- empty without these: three orders (draft, confirmed, converted) with one
  -- untaxed line each. Header totals equal the line sums; the converted one
  -- carries a document_links edge to a real posted invoice so the
  -- converted-link branch renders.
  declare
    v_party uuid;
    v_account uuid;
    v_item uuid;
    v_invoice uuid;
  begin
    select id into v_party from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    select id into v_account from accounts
     where org_id = v_org and type in ('income', 'income_other')
       and is_active and not is_summary
     order by number nulls last limit 1;
    select id into v_item from items
     where org_id = v_org and is_active
     order by name limit 1;
    select id into v_invoice from documents
     where org_id = v_org and kind = 'customer_invoice' and status = 'posted'
     order by document_date limit 1;
    if v_party is null or v_account is null or v_item is null then
      raise notice 'missing party/account/item; skipping sales-order fixtures';
      return;
    end if;

    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, currency,
       status, subtotal, tax_total, total, memo, created_at, updated_at)
    values
      ('00000000-0000-7000-9000-000000000401', v_org, 'sales_order', 'SO-00001',
       v_party, current_date - 9, 'USD', 'draft', 1500.0000, 0.0000, 1500.0000,
       'ViewSpec fixture: open draft order', now(), now()),
      ('00000000-0000-7000-9000-000000000402', v_org, 'sales_order', 'SO-00002',
       v_party, current_date - 4, 'USD', 'confirmed', 2750.0000, 0.0000, 2750.0000,
       'ViewSpec fixture: open confirmed order', now(), now()),
      ('00000000-0000-7000-9000-000000000403', v_org, 'sales_order', 'SO-00003',
       v_party, current_date - 20, 'USD', 'converted', 4200.0000, 0.0000, 4200.0000,
       'ViewSpec fixture: converted order', now(), now())
    on conflict (id) do nothing;

    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit_price, amount)
    values
      ('00000000-0000-7000-9000-000000000411', v_org,
       '00000000-0000-7000-9000-000000000401', 1, v_item, v_account,
       'ViewSpec fixture line', 10, 150.0000, 1500.0000),
      ('00000000-0000-7000-9000-000000000412', v_org,
       '00000000-0000-7000-9000-000000000402', 1, v_item, v_account,
       'ViewSpec fixture line', 11, 250.0000, 2750.0000),
      ('00000000-0000-7000-9000-000000000413', v_org,
       '00000000-0000-7000-9000-000000000403', 1, v_item, v_account,
       'ViewSpec fixture line', 12, 350.0000, 4200.0000)
    on conflict (id) do nothing;

    if v_invoice is not null then
      insert into document_links
        (id, org_id, from_document_id, to_document_id, link_type)
      values ('00000000-0000-7000-9000-000000000421', v_org,
              '00000000-0000-7000-9000-000000000403', v_invoice, 'conversion')
      on conflict (id) do nothing;
    end if;
  end;
```

Caveats for the coordinator (verified as far as read-only queries allow):

- Conflict targets confirmed: `documents_pkey`, `document_lines_pkey`, and
  `document_links_pkey` are all on `id`, so the three `on conflict (id) do
  nothing` clauses above are exact.
- `documents.status` values for orders (`draft`/`confirmed`/`converted`) are
  the domain's own codes, not the approval `STATUS_KEYS` set — the list
  renders whatever the column holds, and the drawer variant opens the *draft*
  order (…401) so the editable branch is exercised.
- The `orders` flag resolves on for the SIM org: its `settings->'features'`
  blob has no `orders` key, and the feature registry declares
  `defaultEnabled: true` — so `requireFeatureEnabled` passes in both
  branches. If that default ever flips, this page 404s natively too.

## 4. What the spec does NOT cover (nothing — full coverage)

- No `sections.tsx`: the page defines no local components. `NewOrderButton`,
  `NewOrderRedirect`, and `OrderDrawer` live in `web/app/(app)/_order/`
  (outside my owned dir, so I did not move them) and the widgets reference
  them directly.
- The drawer fragment (`NewOrderRedirect` + `OrderDrawer`) is two independent
  presence flags in the loader: `showNewRedirect` (`?order=new` + canManage,
  verbatim) places the redirect widget beside the list, and `drawerOpen`
  places the drawer widget *inside* the slot — the same arrangement the
  native page has (redirect + drawer both sit after `RecordListView`'s table,
  drawer via the `drawer` prop).
- The `orders` feature gate (`requireFeatureEnabled` → `notFound()`) runs in
  the LOADER before any query — both branches 404 identically when the
  feature is off. Nothing travels through the spec for it.
- `RecordListView` gets no `renderRowActions` here (the native page passes
  none), so the slot's built-in eye-link fallback is the byte-identical
  render — no row-actions widget needed for this page.
- The coordinator's three callouts do not apply: no `<section>` in the native
  markup (header is `PageHeader`, body is the list), no `tabular-nums` on any
  page-owned `<td>` (all cells render inside `RecordListView`), and no pager
  is placed by the spec (pagination lives inside the slot).
