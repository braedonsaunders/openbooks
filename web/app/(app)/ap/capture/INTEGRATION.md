# /ap/capture ViewSpec integration handoff

Page: `web/app/(app)/ap/capture/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. `CaptureReviewDrawer.tsx` and `CaptureUploadButton.tsx` are
untouched; the drawer and upload button widgets reference them directly.

Spec blocks used: `page-header` (back link + two action widgets),
`grid` (banner wrapper, search/filter row), `widget` (`capture-list`,
`capture-review-drawer`, `search-input`, `filter-chips`), `pagination`
(`bare: true` — the native pager is unwrapped).

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed (all already exist as components):

```tsx
import { ArrowLeft, FileText } from 'lucide-react'
import { CaptureList } from '../../app/(app)/ap/capture/sections'
import { CaptureReviewDrawer } from '../../app/(app)/ap/capture/CaptureReviewDrawer'
import { CaptureUploadButton } from '../../app/(app)/ap/capture/CaptureUploadButton'
```

Entries:

```tsx
/* --- AP capture ----------------------------------------------------------- */
/**
 * The back-to-Bills header action. Diffed against `plain-link-button` and
 * `docs-link-button` before writing: `plain-link-button` renders Link OUTSIDE
 * Button with no icon; `docs-link-button` is `size="sm"` with a 14px icon and
 * no space before the label. The native capture back button is `Button
 * variant="outline" asChild` (default size) with `<ArrowLeft size={14} />`
 * INSIDE the Link, matching the native `<Button variant="outline"
 * asChild><Link …><ArrowLeft size={14} />{label}</Link></Button>` exactly —
 * neither existing entry renders this shape, hence its own entry.
 */
'back-link-button': (props) => {
  const href = str(props, 'href')
  if (!href) return null
  return (
    <Button asChild variant="outline">
      <Link href={href as never}>
        <ArrowLeft size={14} />
        {str(props, 'label') ?? ''}
      </Link>
    </Button>
  )
},
/** The capture upload button. `disabled` is LOADER data (capture
 *  operational = global AI on AND settings enabled AND key AND endpoint);
 *  the uploading state stays inside the client component. Gated in the spec
 *  by `when: canCreate`, matching the native `{canCreate ?
 *  <CaptureUploadButton/> : null}`. */
'capture-upload': (props) => (
  <CaptureUploadButton disabled={props.disabled === true} />
),
/**
 * The not-operational banner content. The spec places the amber wrapper as a
 * `grid` (verbatim class string) and this widget renders the text plus the
 * conditional configure link — a conditional PAIR the loader resolves to
 * `showConfigureLink`, since a spec cannot branch.
 */
'capture-not-configured': (props) => (
  <>
    {str(props, 'text') ?? ''}{' '}
    {props.showConfigureLink === true ? (
      <Link href={(str(props, 'configureHref') ?? '/admin/ai') as never} className="font-medium underline">
        {str(props, 'configureLabel') ?? ''}
      </Link>
    ) : null}
  </>
),
/**
 * The capture queue table. Same doctrine as `admin-users-table`: the native
 * page owns row-selection state, per-row checkboxes (materialized rows are
 * unselectable) and three bulk actions — none of which the spec's two table
 * variants can name — so it stays a component and the spec places it. Moved
 * to `sections.tsx`; `page.tsx` imports it back, so both render paths share
 * one implementation.
 */
'capture-list': (props) => (
  <CaptureList
    rows={(props.rows as ComponentProps<typeof CaptureList>['rows']) ?? []}
    currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    canCreate={props.canCreate === true}
    sort={str(props, 'sort') ?? 'received'}
    dir={str(props, 'dir') === 'desc' ? 'desc' : 'asc'}
  />
),
/**
 * The review flyout. The remount key rides along as a prop: switching
 * documents must reset the drawer's client state, and a widget at a fixed
 * position would otherwise be reused (same pattern as `account-drawer`).
 * `initial`, option lists and both flags travel through the loader result;
 * every bound server action stays inside the client component.
 */
'capture-review-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof CaptureReviewDrawer> & {
    remountKey: string
  }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <CaptureReviewDrawer key={remountKey} {...rest} />
},
```

Note: the drawer renders through `UrlDrawer` with `closeHref="/ap/capture"`,
so the `?capture=<id>` param is consumed by the drawer itself — no
`drawerReturn` handling needed. The drawer is portaled to `<body>`, so the
conformance entry names `[data-drawer-layer]` in `scopes` explicitly.

Why five entries and not one: the header back button and upload button are
separate widgets because they gate independently (back always renders, upload
needs `ap.create`); the banner content, list and drawer render in different
slots with different data.

The `empty-state` registry icon map has no `file-search` icon
(`FileSearch`). The capture list renders its own `EmptyState` internally
(no action button), so no registry change is needed — but if the coordinator
ever decomposes this list, the map will need `'file-search': <FileSearch />`.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

The sim tenant ships ZERO `ap_capture_items` rows (verified: `select
count(*) from ap_capture_items` → `0`), so §3 seeds four rows across five
of the eight statuses (one `needs_review` doubles as the drawer target).
Expected counts below were verified against those fixture ids with
read-only queries.

```js
{
  path: '/ap/capture',
  // The default render carries 4 captures across 5 statuses; the status
  // variant pins the (single-row) failed side; the search variant pins the
  // filename branch of the ilike; the drawer variant opens the needs_review
  // capture with its vendor/account pickers and latest-attempt evidence.
  // The banner variant cannot be a conformance variant: captureOperational
  // is false in the sim tenant on BOTH paths, so it cannot differ.
  variants: [
    '',
    { query: '?status=failed', expect: 'table tbody tr', minMatches: 1 },
    { query: '?q=viewspec-acme', expect: 'table tbody tr', minMatches: 1 },
    {
      query: '?capture=00000000-0000-7000-9000-000000002001',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 4,
},
```

## 3. Proposed fixture SQL (for the coordinator — `scripts/viewspec-fixtures.sql`)

Fresh block claimed: `…2001-2099` (no fixture in the file uses a `…2xxx`
suffix; used suffixes surveyed 2026-09-10: 0001-0003, 0101-0106, 0201-0208,
0301-032, 0403-0413, 042, 0601-0611, 0701-0712, 0901-0912, 1801-1823,
1901-1924, 2801-2803, 3801-3802, 4801-4803, 5801-5804, 6801-6813,
7801-7802, 8801-8891, a000-* — nothing in 20xx-27xx).

Four `ap_capture_items` in the SIM org (`v_org`): one `queued`, one
`needs_review` (= drawer target `…2001`, `vendor_bill`, normalized
`vendorName 'ViewSpec Acme Supplies'`, `invoiceNumber 'VS-1001'`,
`total '1250.00'`, one run attempt 1 with two evidence fields), one
`failed` (`vendor_credit`, `last_error` set), one `materialized`
(`document_kind 'vendor_bill'`, `document_id` NULL — the module never reads
through it). All `received_at` within 3 days, `vendor_candidate_id` NULL
(the vendor search branch is exercised by the `normalized->>'vendorName'`
ilike, not the join), `content_hash` distinct per row, one shared `files`
row (`…2009`, `application/pdf`, `size_bytes 48210`) joined by all four.
Idempotent (`on conflict (id) do nothing`):

```sql
  -- ---- AP capture (…2001-2099) ------------------------------------------------
  --
  -- The simulator never uploads vendor documents, so /ap/capture is empty
  -- without these: four items across four statuses (one needs_review doubles
  -- as the drawer target with a run + evidence). All vendor_candidate_id and
  -- purchase_order_id NULL — the subsidiary scope passes them through, and
  -- the search branch is exercised via normalized->>'vendorName'.
  declare
    v_capture_file uuid := '00000000-0000-7000-9000-000000002009';
  begin
    insert into files
      (id, org_id, folder_id, name, extension, file_type, content_type,
       size_bytes, storage_kind, content_hash, is_inactive)
    values
      (v_capture_file, v_org, null, 'viewspec-invoice-vs-1001.pdf', 'pdf',
       'document', 'application/pdf', 48210, 'db',
       'viewspec-capture-file-2009', false)
    on conflict (id) do nothing;

    insert into ap_capture_items
      (id, org_id, file_id, status, source, original_filename, content_hash,
       document_kind, normalized, validation_issues, overall_confidence,
       received_at)
    values
      ('00000000-0000-7000-9000-000000002001', v_org, v_capture_file,
       'needs_review', 'upload', 'viewspec-acme-invoice.pdf',
       'viewspec-capture-2001', 'vendor_bill',
       '{"vendorName": "ViewSpec Acme Supplies", "invoiceNumber": "VS-1001",
         "invoiceDate": "2026-08-14", "currency": "USD", "total": "1250.00",
         "subtotal": "1157.41", "taxTotal": "92.59", "memo": null,
         "dueDate": null,
         "lines": [{"description": "ViewSpec fixture line",
                    "productCode": null, "quantity": "1.0000", "unit": null,
                    "unitPrice": "1250.0000", "amount": "1250.0000",
                    "taxAmount": "0.0000", "accountId": null, "itemId": null,
                    "purchaseOrderLineId": null, "confidence": null}]}'::jsonb,
       '[{"code": "vendor_unresolved", "severity": "blocking"}]'::jsonb,
       0.8200, now() - interval '3 hours'),
      ('00000000-0000-7000-9000-000000002002', v_org, v_capture_file,
       'queued', 'upload', 'viewspec-queued-scan.pdf',
       'viewspec-capture-2002', 'vendor_bill',
       '{"vendorName": null, "invoiceNumber": null, "invoiceDate": null,
         "currency": null, "total": null, "lines": []}'::jsonb,
       '[]'::jsonb, null, now() - interval '1 hour'),
      ('00000000-0000-7000-9000-000000002003', v_org, v_capture_file,
       'failed', 'upload', 'viewspec-failed-scan.pdf',
       'viewspec-capture-2003', 'vendor_credit',
       '{"vendorName": "ViewSpec Acme Supplies", "invoiceNumber": "VS-1002",
         "invoiceDate": null, "currency": "USD", "total": null,
         "lines": []}'::jsonb,
       '[{"code": "required_field", "severity": "blocking",
          "field": "invoiceDate"}]'::jsonb,
       0.3100, now() - interval '2 days'),
      ('00000000-0000-7000-9000-000000002004', v_org, v_capture_file,
       'materialized', 'upload', 'viewspec-done-invoice.pdf',
       'viewspec-capture-2004', 'vendor_bill',
       '{"vendorName": "ViewSpec Acme Supplies", "invoiceNumber": "VS-0998",
         "invoiceDate": "2026-07-30", "currency": "USD", "total": "842.10",
         "lines": [{"description": "ViewSpec fixture line",
                    "productCode": null, "quantity": "1.0000", "unit": null,
                    "unitPrice": "842.1000", "amount": "842.1000",
                    "taxAmount": "0.0000", "accountId": null, "itemId": null,
                    "purchaseOrderLineId": null, "confidence": null}]}'::jsonb,
       '[]'::jsonb, 0.9700, now() - interval '3 days')
    on conflict (id) do nothing;

    insert into ap_capture_runs
      (id, org_id, capture_item_id, attempt, provider, model, api_version, status)
    values
      ('00000000-0000-7000-9000-000000002011', v_org,
       '00000000-0000-7000-9000-000000002001', 1,
       'azure_document_intelligence', 'prebuilt-invoice', '2024-02-29-preview',
       'succeeded')
    on conflict (id) do nothing;

    insert into ap_capture_fields
      (id, org_id, run_id, field_key, line_index, raw_value,
       normalized_value, confidence, page_number)
    values
      ('00000000-0000-7000-9000-000000002021', v_org,
       '00000000-0000-7000-9000-000000002011', 'invoiceNumber', null,
       'VS-1001', '"VS-1001"'::jsonb, 0.9900, 1),
      ('00000000-0000-7000-9000-000000002022', v_org,
       '00000000-0000-7000-9000-000000002011', 'total', null,
       '1250.00', '"1250.00"'::jsonb, 0.9400, 1)
    on conflict (id) do nothing;
  end;
```

Note: `ap_capture_runs`/`ap_capture_fields` full column lists were read
from `information_schema` 2026-09-10 (`runs`: id, org_id,
capture_item_id, attempt, provider, model, api_version, status,
raw_provider_payload; `fields`: + raw_value, normalized_value,
confidence, page_number, polygon, created_at — nullable columns omitted).
`polygon` is NULL: the highlight-evidence button needs
`contentType image/*` (fixture file is `application/pdf` → iframe branch),
so the button never renders in the harness — same render on both paths.

## 4. What the spec does NOT cover (nothing — full coverage)

- No `sections.tsx` composite cells: the table's per-row link + kind line
  and status badges render inside `CaptureList` itself, not as spec cells.
- The header action pair (`Back` always, `Upload` iff `ap.create`) is loader
  presence: an unconditional `back-link-button` widget plus a
  `when: canCreate` `capture-upload` widget with
  `actionsClassName: 'flex items-center gap-2'`, matching the native
  `<div className="flex items-center gap-2">` (PageHeader wraps actions in
  its own flex container — `actionsClassName` sets the INNER div the native
  page owns, verified against `packages/ui/src/page-header.tsx`).
- The `notConfigured` banner pair (text + conditional `/admin/ai` link gated
  on `admin.ai.manage`) is loader presence (`showBanner` /
  `showConfigureLink`).
- The review drawer's every branch (processing spinner, failure note,
  issue list, draft link, editable vs read-only fields, PO lookup behind
  `purchase_order` kind enablement, evidence confidence badges) stays inside
  `CaptureReviewDrawer`; the loader only resolves its data.
- The bulk-action buttons inside `CaptureList` call
  `/api/ap-capture/actions` directly — no server action crosses the spec.

## 5. GATES check (not just row counts)

- Page gate is `requirePermission('ap.read')`. The harness user holds the
  admin role, which includes `ap.read`, `ap.create` AND `admin.ai.manage`
  (verified 2026-09-10) — so the upload button renders and the banner's
  configure link renders on both paths.
- `allowedSubsidiaryIds` is null for the harness user (admin role
  `subsidiary_restriction {"mode": "all"}`), so every `…Scope` fragment is
  `sql``` — the subsidiary branches cannot differ between paths.
- `canLookupPurchaseOrders = isDocKindEnabled(org, 'purchase_order')`
  resolves identically in both paths (same org, same features table).
- `captureOperational` is false in the sim tenant on BOTH paths (no AI
  settings row configured), so the upload button is disabled and the banner
  shows on both — no divergent branch.
