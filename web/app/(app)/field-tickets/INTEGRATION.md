# /field-tickets ViewSpec integration handoff

Page: `web/app/(app)/field-tickets/` — owner files are `view.ts` (+ this file)
and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`: the
page needs no composite cells (see §4).

Spec widgets used: `pageHeader` block + `new-order`, `record-list-view`,
`field-ticket-drawer`. `new-order` and `record-list-view` already exist in the
registry (shared with the three order pages); only `field-ticket-drawer` is
proposed below.

Note: field tickets render through the universal `RecordListView` with NO
`renderRowActions` (unlike AR invoices), so this page needs no row-actions
widget — the slot's built-in eye-link fallback is the native render.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

Depends on the `record-list-view` widget + `RecordListSlot` (already
integrated and harness-verified) and on the shared `new-order` entry the
three order pages registered. New import needed on top of those:

```tsx
import { FieldTicketDrawer } from '../../app/(app)/field-tickets/FieldTicketDrawer'
```

Entry:

```tsx
/* --- field tickets -------------------------------------------------------- */
/** No remount key: the native page renders this drawer keyless (its state
 *  resets from effects on the ticket id, the same precedent as
 *  `journal-drawer`). `initialMode` rides inside the props, exactly as the
 *  native page spreads `{...drawerData, initialMode}`. */
'field-ticket-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof FieldTicketDrawer> & { initialMode?: 'view' | 'edit' }) | null
  if (!drawer) return null
  return <FieldTicketDrawer {...drawer} />
},
```

`FieldTicketDrawer` takes `ticket`, the seven picker arrays
(`employees`/`laborItems`/`timeTypes`/`catalogItems`/`projects`/`projectTasks`/
`equipmentUnits`), `equipmentEnabled`, form-layout fields (`layout`,
`availableLayouts`, `currentLayoutId`, `canCustomize`), `canManage`, and
optional `initialMode` — all plain JSON-serializable data. Unlike
`OrderDrawer` it has no kind-specific trailing section and no `key`.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

The sim tenant has 500 `field_ticket` documents but ZERO `field_tickets`
extension rows — the seeder wrote `documents` without the 1:1 extension, so
the list's inner join (`web/lib/list/sources.ts`) yields nothing today, and
the drawer loader (`loadHeader`, inner join) returns null for any real
`?ticket=` id. This page needs fixture rows first (SQL in §3 — please fold
into `scripts/viewspec-fixtures.sql`; fresh `...000801`–`...000813` id block,
verified unused). After fixtures, the entry:

```js
{
  path: '/field-tickets',
  // The universal record list + the ticket flyout. Three fixture tickets
  // (draft, submitted, approved) pin the table path; the drawer variant
  // opens a real ticket with its pickers and form layout.
  variants: [
    '',
    {
      query: '?ticket=00000000-0000-7000-9000-000000000801',
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

Row-count verification (read-only queries): `select count(*) from documents
where kind = 'field_ticket'` → 500 today but all extension-less, so the
list join yields 0 rows; the `minMatches: 3` above counts the three fixture
tickets from §3 (all visible: `subsidiary_id` null, harness user is admin
with `subsidiary_restriction {"mode": "all"}`). The drawer variant opens the
draft fixture (…801); its project is a real sim project, so `projectTasks`
is non-empty, and the `time_types`/`items` pickers resolve (1
field-ticket-enabled time type, 3 active items in the sim org today).

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Three `field_ticket` documents in the SIM org (fixed ids, `ON CONFLICT DO
NOTHING`, same idempotent style as the existing file) plus their 1:1
`field_tickets` extension rows — draft, submitted, approved, so the status
chips and the approval branches have rows. The shape mirrors
`createFieldTicket` in `web/lib/field-tickets.ts` (header `documents` row +
extension row; `billing_method 'time_and_materials'`; zeroed totals).

```sql
  -- ---- field tickets ---------------------------------------------------------
  --
  -- The simulator writes field-ticket documents but no field_tickets extension
  -- rows, so the /field-tickets list (inner join) is empty and the drawer
  -- (inner join) resolves null for every real id. Three tickets with their
  -- extension rows (draft, submitted, approved) on one real sim project, so
  -- the status chips, the project picker, and the draft pickers all render.
  declare
    v_project uuid;
    v_customer uuid;
    v_foreman uuid;
  begin
    select id, customer_id into v_project, v_customer from projects
     where org_id = v_org and is_active
     order by name limit 1;
    select p.id into v_foreman from parties p
     where p.org_id = v_org and p.is_active
       and exists (
         select 1 from employee_roles r
          where r.party_id = p.id and r.org_id = p.org_id and r.is_active
       )
     order by p.display_name limit 1;
    if v_project is null then
      raise notice 'missing project; skipping field-ticket fixtures';
      return;
    end if;

    insert into documents
      (id, org_id, kind, document_number, document_date, currency, status,
       party_id, project_id, subsidiary_id, billing_method,
       subtotal, tax_total, total, custom)
    values
      ('00000000-0000-7000-9000-000000000801', v_org, 'field_ticket', 'FT-VIEWSPEC-1',
       current_date - 2, 'USD', 'draft', v_customer, v_project, null,
       'time_and_materials', 0, 0, 0, '{}'::jsonb),
      ('00000000-0000-7000-9000-000000000802', v_org, 'field_ticket', 'FT-VIEWSPEC-2',
       current_date - 9, 'USD', 'pending_approval', v_customer, v_project, null,
       'time_and_materials', 0, 0, 0, '{}'::jsonb),
      ('00000000-0000-7000-9000-000000000803', v_org, 'field_ticket', 'FT-VIEWSPEC-3',
       current_date - 16, 'USD', 'approved', v_customer, v_project, null,
       'time_and_materials', 0, 0, 0, '{}'::jsonb)
    on conflict (id) do nothing;

    insert into field_tickets
      (document_id, org_id, period, period_start, period_end, foreman_party_id)
    values
      ('00000000-0000-7000-9000-000000000801', v_org, 'weekly',
       current_date - 8, current_date - 2, v_foreman),
      ('00000000-0000-7000-9000-000000000802', v_org, 'weekly',
       current_date - 15, current_date - 9, v_foreman),
      ('00000000-0000-7000-9000-000000000803', v_org, 'weekly',
       current_date - 22, current_date - 16, v_foreman)
    on conflict (document_id, org_id) do nothing;
  end;
```

Caveats for the coordinator (verified as far as read-only queries allow):

- Conflict targets need confirming against the live schema before applying:
  `documents_pkey` is on `id` (same as the order fixtures); the
  `field_tickets` target above assumes a `(document_id, org_id)` unique key —
  please verify (`\d field_tickets`) and adjust if the PK is `document_id`
  alone.
- `documents.status` values (`draft`/`pending_approval`/`approved`) match the
  `fieldTickets.json` `status.*` keys the drawer/list render.
- `period 'weekly'` is one of the drawer's known periods and matches the
  resolved project policy fallback (`coalesce(..., 'weekly')`).
- The `fieldTickets` flag resolves on for the SIM org: its
  `settings->'features'` blob has no `fieldTickets` key, and the feature
  registry declares `defaultEnabled: true` — so both branches render in both
  paths. If that default ever flips, this page 404s natively too.

## 4. What the spec does NOT cover (nothing — full coverage)

- No `sections.tsx`: the page defines no local components. `NewOrderButton`
  lives in `web/app/(app)/_order/` and `FieldTicketDrawer` in this dir
  (outside-spec components the widgets reference directly) — nothing needed
  moving because the native branch already imports both from their homes.
- The drawer is a single presence flag: `loadFieldTicketDrawerData` returns
  null for a missing/unauthorized ticket (verbatim native behavior), and the
  drawer widget renders only when non-null. Unlike the order pages there is
  no `?<param>=new` redirect — the New button POSTs the draft API directly.
- The `fieldTickets` feature gate (`notFound()`) runs in the LOADER before
  any query — both branches 404 identically when the feature is off. Nothing
  travels through the spec for it.
- `RecordListView` gets no `renderRowActions` here (the native page passes
  none), so the slot's built-in eye-link fallback is the byte-identical
  render — no row-actions widget needed for this page.
- No `<section>` in the native markup (header is `PageHeader`, body is the
  list), no `tabular-nums` on any page-owned `<td>` (all cells render inside
  `RecordListView`), and no pager is placed by the spec (pagination lives
  inside the slot).
