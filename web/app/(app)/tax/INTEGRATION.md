# /tax ViewSpec integration handoff

Page: `web/app/(app)/tax/` — owner files are `view.ts`, `sections.tsx`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.
`TaxFilingsView.tsx` and `FilingHistoryDrawer.tsx` are untouched; both
render paths share them through `sections.tsx`.

Spec widgets used: `tax-page`, `tax-filing-drawer` (both proposed below —
neither exists in the registry yet). No other widgets: the header is not
`pageHeader`, the tab strip is not `tab-nav`, and the history table is not a
`table` block (see §4).

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (all components already exist as shared implementations in
this page's `sections.tsx`):

```tsx
import {
  TaxFilingDrawer,
  TaxHistoryTable,
  TaxPageHeader,
  TaxPageShell,
  TaxPreparePanel,
  TaxTabPanels,
  TaxTabs,
} from '../../app/(app)/tax/sections'
```

Entries (proposed location: after the `receipts-view-tabs` / payments block,
or wherever page-level widgets cluster):

```tsx
/* --- tax ------------------------------------------------------------------ */
/**
 * The whole tax page through one widget. Coarse by necessity: the native
 * page sits in `PageContainer`, whose `FadeInBody` motion wrappers carry
 * `data-page-motion` attributes and post-animation inline styles that a spec
 * `grid` (a plain div) cannot reproduce — so the spec draws no chrome of its
 * own. Every visual unit below is a shared component the native branch also
 * renders; the entry only binds loader data to props. The tab presence flags
 * are loader-computed and applied inside `TaxTabPanels`, exactly as the
 * native `{tab === ... ? ... : ...}` does — a `when` cannot cross a widget
 * boundary.
 */
'tax-page': (props) => (
  <TaxPageShell>
    <TaxPageHeader
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      setupHref={str(props, 'setupHref') ?? '/admin/setup/tax-return-forms'}
      setupLabel={str(props, 'setupLabel') ?? ''}
      canManageSetup={props.canManageSetup === true}
    />
    <TaxTabs
      tabs={
        (props.tabs as ComponentProps<typeof TaxTabs>['tabs']) ?? []
      }
    />
    <TaxTabPanels
      tabKey={str(props, 'tabKey') ?? 'prepare'}
      onPrepare={props.onPrepare === true}
      onHistory={props.onHistory === true}
      prepare={
        <TaxPreparePanel
          forms={(props.forms as ComponentProps<typeof TaxPreparePanel>['forms']) ?? []}
          canSave={props.canSave === true}
          canManageSetup={props.canManageSetup === true}
        />
      }
      history={
        <TaxHistoryTable
          {...(props.history as ComponentProps<typeof TaxHistoryTable>)}
        />
      }
    />
  </TaxPageShell>
),
/** The remount key rides along as a prop: opening a different filing must
 *  reset the drawer's client state, and a widget at a fixed position would
 *  otherwise be reused (same pattern as `account-drawer` / `party-drawer`). */
'tax-filing-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof TaxFilingDrawer>['drawer']
  if (!drawer) return null
  return <TaxFilingDrawer drawer={drawer} />
},
```

Why one page widget and not five: the shell forces it. Five separate widget
blocks (`tax-page-header`, `tax-tabs`, `tax-prepare-panel`,
`tax-history-table` in a `bare` body) would still need a `PageContainer`
around them that only a widget can render — and a shell widget taking region
refs would be machinery with no parity benefit over composing the shared
components directly. The drawer stays separate because it is portaled (needs
the `[data-drawer-layer]` scope in the drawer variant) and genuinely
conditional (`when: drawerOpen` at spec level).

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/tax',
  // The prepare tab is a client component (form Select + date inputs +
  // compute button); the history tab is the hand-rolled filings table; the
  // drawer variant opens a real prepared filing with its mark-as-filed form.
  variants: [
    { query: '', expect: 'main select, main input', minMatches: 1 },
    { query: '?tab=history', expect: 'table tbody tr', minMatches: 3 },
    {
      query: '?tab=history&status=filed',
      expect: 'table tbody tr',
      minMatches: 1,
    },
    {
      query: '?tab=history&filing=00000000-0000-7000-9000-000000006811',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      // The flyout is portaled to <body>, so it has to be named explicitly
      // or the comparison never looks at it.
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'main select, main input',
  minMatches: 1,
},
```

GATES verification (read-only queries against `openbooks_sim_viewspec`):

- `requirePermission('reports.read')` — harness user `viewspec@sim.test`
  holds the `admin` role, whose permission set includes `reports.read`,
  `reports.create` and `admin.setup.manage` (verified: full permission list
  read from `app_roles` for the harness org `da472d3a-…`).
- Subsidiary fence (`allowedSubsidiaryIds !== null` → 404) — the harness
  user's `admin` role carries `subsidiary_restriction {"mode": "all"}`,
  i.e. unrestricted ⇒ `allowedSubsidiaryIds` is null ⇒ no 404 (verified).
- Row counts — the sim tenant currently holds ZERO `tax_return_forms` and
  ZERO `tax_filings` (verified), so post-fixture counts equal the fixture
  counts exactly: 2 forms ⇒ prepare `select` has its options and the form
  filter has 2 options; 3 filings ⇒ history `tbody tr` = 3; 1 filed ⇒
  `status=filed` variant = 1 row; drawer id `…000000006811` is a prepared
  filing in the harness org, so the drawer (with mark-as-filed form, since
  `canFile` is true) renders.
- `assertVariantsDiffer` — the four variants render distinct markup
  (prepare panel vs 3-row table vs 1-row table vs table + portaled drawer).

## 3. Fixture SQL (for the coordinator — append to `scripts/viewspec-fixtures.sql`)

Fresh block claimed: `…6801-6899` (no existing fixture id uses the `0000068xx`
range — verified by enumerating every `00000000-0000-7000-9000-00000…` id in
the file). Two forms (one with an official PDF flag on, one off, so both
`TaxFilingsView` branches have data behind them) and three filings (two
prepared across two periods + one filed, so the status chip, the sort orders
and the pager all have something to select):

```sql
  -- Tax return forms + filing history for the /tax conversion. The prepare
  -- tab needs at least one active form (its Select, submission panel and
  -- compute flow); the history tab needs rows across both statuses.
  insert into tax_return_forms
    (id, org_id, code, name, country, submission_channel, government_format,
     submission_url, is_active, official_pdf_file_id)
  values
    ('00000000-0000-7000-9000-000000006801', v_org, 'CA_GST34',
     'GST/HST return', 'CA', 'portal_manual', 'portal_entry',
     'https://www.canada.ca/en/revenue-agency.html', true, null),
    ('00000000-0000-7000-9000-000000006802', v_org, 'US_941',
     'Employer quarterly federal tax return', 'US', 'efile_api', 'api',
     null, true, null)
  on conflict (id) do nothing;

  insert into tax_filings
    (id, org_id, form_code, form_name, country, period_from, period_to,
     version, status, submission_channel, boxes, snapshot_hash,
     filing_reference, filed_at)
  values
    ('00000000-0000-7000-9000-000000006811', v_org, 'CA_GST34',
     'GST/HST return', 'CA', '2026-01-01', '2026-03-31',
     1, 'prepared', 'portal_manual',
     '[{"lineCode": "101", "label": "Sales and other revenue", "value": "48250.00", "computed": false, "editable": true}, {"lineCode": "105", "label": "Total GST/HST collected", "value": "2412.50", "computed": true, "editable": false}]'::jsonb,
     repeat('a', 64), null, null),
    ('00000000-0000-7000-9000-000000006812', v_org, 'CA_GST34',
     'GST/HST return', 'CA', '2025-10-01', '2025-12-31',
     1, 'filed', 'portal_manual',
     '[{"lineCode": "101", "label": "Sales and other revenue", "value": "41100.00", "computed": false, "editable": true}, {"lineCode": "105", "label": "Total GST/HST collected", "value": "2055.00", "computed": true, "editable": false}]'::jsonb,
     repeat('b', 64), 'CRA-CONF-2025-Q4', now() - interval '40 days'),
    ('00000000-0000-7000-9000-000000006813', v_org, 'US_941',
     'Employer quarterly federal tax return', 'US', '2026-01-01', '2026-03-31',
     1, 'prepared', 'efile_api',
     '[{"lineCode": "5a", "label": "Taxable social security wages", "value": "120000.00", "computed": false, "editable": true}, {"lineCode": "5c", "label": "Total income tax withheld", "value": "18000.00", "computed": true, "editable": false}]'::jsonb,
     repeat('c', 64), null, null)
  on conflict (id) do nothing;
```

Constraint notes (all verified against the live sim schema):

- `tax_filings_status_check` allows only `prepared`/`filed` ✓.
- `tax_filings_filed_state_check`: `prepared` ⇔ `filed_at IS NULL`,
  `filed` ⇔ `filed_at IS NOT NULL` ✓ (the filed row carries a timestamp).
- `tax_filings_snapshot_hash_check`: `^[0-9a-f]{64}$` — `repeat('a',64)` etc.
  satisfy it ✓. `tax_filings_boxes_check`: boxes must be a JSON array ✓.
- `tax_filings_period_version` unique on
  `(org_id, form_code, period_from, period_to, version)` — all three rows
  differ ✓. `tax_return_forms_code_org` unique on `(org_id, code)` ✓.
- `submission_channel` ∈ `print_pdf/file_upload/efile_api/portal_manual` ✓;
  `government_format` ∈ `portal_entry/certified_file/api/paper` ✓.
- `country` is free text on both tables; `official_pdf_file_id` FK is
  nullable (left null — no file fixture needed) ✓.

## 4. What the spec does NOT cover (deliberate, documented)

- No `pageHeader` block: the native header is a hand-rolled `h1` +
  description row, not the shared `PageHeader` (different elements, different
  classes). It renders through the shared `TaxPageHeader`.
- No `tab-nav` widget: the strip carries a count badge and uses
  `aria-current` instead of `role="tab"`. Separate component, same reason the
  payments and receipts strips stayed separate.
- No `frame('tab-content')` in the spec: the `TaxTabPanels` component renders
  the shared `TabContent` with the loader flags, identically on both paths.
  A spec-level frame would need a shell that only a widget can provide.
- No `table`/`pagination` blocks: the history table is hand-rolled markup
  (the admin-users precedent) with its own `SortTh`/`Pagination` inside the
  shared component.
- Nothing else is unexpressed. Authz decisions (`canManageSetup`, `canSave`,
  `canFile`) are loader-derived booleans, never capability objects; the
  subsidiary 404 fence runs in the loader before any query.
