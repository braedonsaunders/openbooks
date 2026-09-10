# INTEGRATION — `/admin/setup/payment-operations` ViewSpec conversion

Page: `web/app/(app)/admin/setup/payment-operations/page.tsx`.
Status: **converted, pending registry.** `view.ts`, `sections.tsx`, and the
`__viewspec` branch in `page.tsx` are written; the spec references the widget
names proposed below, which do not exist in `WIDGET_REGISTRY` yet. Until the
coordinator registers them, the `?__viewspec=1` path throws
`UnknownWidgetError` at render — the native branch is untouched and ships
(the editor drawer plus the two shared chrome pieces live in `sections.tsx`:
single implementations reached through the registry).

No `packages/viewspec` language change is needed. Everything below is three
registry entries (shared-component passthrough, same pattern as
`account-drawer` / `payroll-setup-tabs`), plus whole-page slots that already
exist in this directory.

## 1. Proposed `WIDGET_REGISTRY` entries (coordinator: `web/components/viewspec/widgets.tsx`)

```tsx
import {
  NewSetupRecordButton,
  PaymentOperationsEditor,
  PaymentOperationsTabs,
  PaymentScheduleNextRun,
} from '../../app/(app)/admin/setup/payment-operations/sections'

// Four-view tab strip. The active-vs-plain link PAIR lives in the shared
// component (presence cannot choose between two treatments) — the payroll
// `PayrollSetupTabs` precedent. Byte contract: the native strip is a bare
// `div.flex.flex-wrap.gap-1.border-b…` of plain links with no roles; this
// wrapper renders exactly that element with loader-resolved hrefs/labels.
// FLAT PROPS: { tabs: { key, href, label, active }[] }.
'payment-operations-tabs': (props) => (
  <PaymentOperationsTabs
    tabs={(props.tabs as ComponentProps<typeof PaymentOperationsTabs>['tabs']) ?? []}
  />
),

// Per-view "New …" button. A `link-button` cannot render it: the native
// button carries a `Plus size={15}` icon and `link-button`'s closed icon map
// has no `plus` key. Renders `Button asChild > Link[href] > Plus(15) +
// label`, byte-identical to the native header action.
// FLAT PROPS: { href: string, label: string } — both loader-resolved.
'new-setup-record': (props) => (
  <NewSetupRecordButton href={str(props, 'href') ?? ''} label={str(props, 'label') ?? ''} />
),

// Schedules "Next run" cell. The native row formats `next_run_at`
// CLIENT-side (`new Date(v).toLocaleString()`, em-dash fallback) — browser
// locale/timezone, not the server's — so the loader passes the raw ISO
// string (Date serialized) and this cell runs the identical expression.
// A `text` cell cannot do this: the loader must never format it.
// FLAT PROPS: { value: string | null }.
'payment-schedule-next-run': (props) => (
  <PaymentScheduleNextRun value={(props.value as string | null) ?? null} />
),

// The create/edit drawer with its four per-view field sets (profile, format,
// schedule, mandate) plus the write-only originator-secrets block, the
// preset pill row, and the save fetch flow. `SetupEditor` owns client form
// state a spec cannot name (the /tax and payroll precedents), so the drawer
// stays whole and the spec places it by name over loader-resolved props.
// `editor` is null unless `?row=` names a uuid row or `row=new` — the slot
// renders nothing otherwise, so the spec's `editorOpen` flag is belt and
// braces. SINGLE OBJECT PROP (flat `view`/`row`/`creating` siblings would
// collide with nothing, but the object keeps the drawer payload one opaque
// bag like `document-drawer`'s `{ drawer }`): 
//   { editor: { view, row, creating, options, multiCurrency, closeHref } | null }
// `row` is the raw `select *` record (or null when creating); `options` is
// the eight-list payload `{ formats, bankAccounts, accountingAccounts,
// subsidiaries, sftpServers, profiles, parties, currencies }` as the native
// page builds it (subsidiaries already gated on the subsidiary UI flag).
'payment-operations-editor': (props) => {
  const editor = props.editor as
    | (ComponentProps<typeof PaymentOperationsEditor>['editor'] | null)
  if (!editor) return null
  return <PaymentOperationsEditor editor={editor} />
},
```

Slot remount keys: none needed. The native `SetupEditor` carries no `key`
prop (unlike the party/account drawers), so the registry must NOT invent
one.

## 2. Spec notes (`view.ts` as written)

- Layout `bare`: the setup workspace renders its own shell around every
  setup page. The spec owns its outer `<div className="space-y-4">` as a
  `grid` in body; `header` is empty ([entity] precedent).
- Header composition: bare `<div>` (a classless `grid`) → `heading(2, …,
  'text-lg font-semibold …')` + `textBlock(description, { size: 'sm',
  className: 'text-slate-500 dark:text-slate-400' })`. The spec does NOT use
  `pageHeader`: the native page owns a raw `<h2>`+`<p>`, not the shared
  `PageHeader` (which renders `h1`, `DocumentTitle`, `space-y-2` chrome).
  Text-block size `sm` renders `text-sm` (native `text-sm`); the
  `text-slate-500 dark:text-slate-400` classes ride `className`, and tone is
  unset so no tone class is emitted.
- Tab strip: `payment-operations-tabs` widget block (shared chrome above).
- Filter row: `grid('flex flex-col gap-3 sm:flex-row sm:items-center
  sm:justify-between')` → `grid('flex flex-wrap items-center gap-2')` →
  `search-input` + `filter-chips` (`paramKey: 'state'`, default `page`
  reset), plus the `new-setup-record` widget. No `defaultValue`: the native
  `FilterChips` has none, so all-states is the bare param (the [entity]
  `show-inactives-toggle` precedent does not apply — this page uses chips).
- Four mutually exclusive `app`-variant tables behind `onProfiles` /
  `onFormats` / `onSchedules` / `onMandates` (accounts precedent); exactly
  one flag is true per render. Each table lives in the native card wrapper
  grid (`overflow-hidden rounded-xl border …`); the `app` table renders no
  wrapper of its own. No `sorting`: the native page allows only `default`.
- Cell mapping mirrors `SetupTable` exactly:
  - profiles: name link (`font-medium text-teal-700 hover:underline
    dark:text-teal-300`) / bank join (`number · name`, loader-joined) /
    format / currency `Column.className: 'font-mono text-xs'` (the class
    lives on the native `<td>`, so it rides the COLUMN — a text-cell
    `className` would wrap it in a span the native row lacks) / delivery
    (`sftp_server_name ?? manualDelivery`, loader-resolved) / approval
    (`runApproval`/`automatic`, loader-resolved) / status badge
    (`success`/`outline`, loader-resolved label).
  - formats: code link (additionally `font-mono text-xs font-semibold`) /
    name / rail badge (always `outline`, loader-resolved `rails.*` label) /
    direction (loader-resolved `directions.*` label) / currency with the
    `any` fallback loader-resolved / status badge as profiles.
  - schedules: name link / profile / cron mono column / next-run widget
    cell (client-side `toLocaleString`, see registry) / action
    (loader-resolved `actions.*` label) / status badge as profiles.
  - mandates: reference link (code-link treatment) / party / scheme
    (loader-resolved `schemes.*` label) / signedOn + expiresOn with the
    native em-dash fallback loader-resolved / status badge `success` for
    `active`, `destructive` for `revoked`, `secondary` otherwise
    (loader-resolved label).
- Null link labels: every first-column value is NOT NULL in the schema, so
  the `link` cell's degrade-to-text branch (empty href/label) cannot fire
  on real rows; fixture `name`/`code` values are non-empty.
- `emptyRow` (NOT `empty`): the native page keeps its headers and renders
  `TableCell colSpan={cols[view].length} className="py-10 text-center
  text-slate-500"` — `colSpan` 7/6/6/6 per view, text the loader-resolved
  `empty` string. (`empty` would replace the table with `EmptyState`;
  wrong markup.)
- Pagination: `bare: true` — the native pager sits flush in the `space-y-4`
  flow with no `mt-3` wrapper.
- Drawer: `payment-operations-editor` widget block gated by `editorOpen`
  (`creating || selected !== null`, verbatim). Org guard verbatim: the open
  query filters `org_id = ${orgId}`, and `selected` is `open.rows[0] ??
  null` — a foreign-tenant `?row=` uuid resolves to null and the drawer
  stays shut.
- Permissions/visibility: `requirePermission('admin.setup.manage')` gates
  the loader; all four list queries, searches, state filters and the five
  state-count shapes are copied verbatim, so counts describe exactly what
  is shown. GATES (not just row counts): (a) `?view=` unknown/omitted →
  `profiles` (whitelist + fallback verbatim); (b) `?row=` non-uuid →
  ignored (`isUuid` guard verbatim — the drawer stays shut AND no open
  query fires); (c) subsidiary options `[]` unless the subsidiary UI flag
  (the `subsidiaryUiEnabled ? rows : []` ternary verbatim); (d) mandate
  chips use `status` values while the other three views use
  `active`/`archived` (the `status as value` vs `is_active` bucketing
  verbatim — a `?state=active` on mandates matches nothing, natively).
- Loader-resolved treatments (the /banking lesson): every `active` boolean,
  every tab's `active`, the bank join, the delivery/approval/currency
  fallbacks, the badge variants, the em-dashes, and the `nextRunAt` ISO
  passthrough travel as DATA. The spec binds `text`/`link`/`badge`/one
  widget cell directly.

Message keys: all resolved in the loader via the same key strings the
native page uses (`title`, `description`, `tabs.*`, `search.*`, `state`,
`new.*`, `columns.*`, `states.*`, `rails.*`, `directions.*`,
`actions.create_draft/submit_for_approval`, `schemes.*`, `empty`,
`manualDelivery`, `runApproval`, `automatic`, `any`). No invented keys.
`Unknown` rail/direction/scheme/action/status values render the translator
fallback exactly as natively (same `t()` call, same missing-key path).

## 3. Proposed conformance registry entry (coordinator: `scripts/viewspec-conformance.mjs`)

DB state verified read-only against `openbooks_sim_viewspec` on
127.0.0.1:55439 (`app.bypass_rls='on'`), harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` (`viewspec@sim.test`, holds
`admin.setup.manage` via the admin role — verified in the role's
permissions array):

- `payment_formats`: 8 rows in the harness org (CPA005, CHEQUE,
  NACHA-CREDIT, NACHA-DEBIT, POSITIVE-PAY, SEPA-CREDIT, SEPA-DEBIT, WIRE),
  all `is_active` — state chips render a single `active/8` chip. First row
  in native order (`is_active desc, name`): CPA005
  (`01a083e6-dcad-7860-83c3-a761cb99a3e3`). `?q=zzzznomatch` count verified
  0 (in-table empty row, headers stay).
- `payment_bank_profiles`, `payment_schedules`, `payment_mandates`: 0 rows
  each in the harness org — the profiles/schedules/mandates tabs are
  natively EMPTY there, so table-path coverage for those views (and the
  drawer, whose open queries need a row id) depends on the fixture block
  below. An empty-profiles variant is NOT coverage of the profiles table —
  it exercises only `emptyRow`.
- `party_bank_accounts` (approved+active, party active): 0 in the harness
  org — the mandate fixture must plant its own bank account (and the
  parties options query needs it too).

```js
{
  path: '/admin/setup/payment-operations',
  // Default view is profiles (empty in the sim org → in-table empty row
  // with headers intact); view=formats hits the 8 seeded formats.
  variants: [
    '',
    '?view=formats',
    '?view=schedules',
    '?view=mandates',
    { query: '?view=formats&q=zzzznomatch', expect: 'table thead th', minMatches: 6 },
    { query: '?view=formats&state=archived', expect: 'table tbody tr', minMatches: 0 },
  ],
  expect: 'table tbody tr',
  minMatches: 8,
},
{
  path: '/admin/setup/payment-operations',
  // Drawer variants need fixture rows (see §4): profile/schedule/mandate
  // ids plus one known format id. The drawer portals to <body>.
  variants: [
    {
      query: '?view=formats&row=01a083e6-dcad-7860-83c3-a761cb99a3e3',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
    {
      query: '?view=profiles&row=00000000-0000-7000-9000-000000009001',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 1,
},
```

## 4. Proposed fixture SQL (coordinator: `scripts/viewspec-fixtures.sql`)

Fresh block `…9001-…` — verified free: zero `000000009___` ids exist in
the file and zero `…9000-9000-000000009%` ids exist in any of the four
tables. No user triggers on any of the four tables (verified:
`pg_trigger` count 0 excluding internals), and the only CHECK on the set
is `party_bank_accounts_retirement_evidence` (untouched — the fixture row
stays active). Plain `INSERT … ON CONFLICT (id) DO NOTHING` is genuinely
idempotent here; no pre-insert guard needed. References live SIM rows so
the joins resolve: format = first SIM `payment_formats` row in native
order for the harness org (`01a083e6-dcad-7860-83c3-a761cb99a3e3`,
CPA005), funding account = `a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e`
(1010 Operating Account, `asset_bank`, active, non-summary — verified),
party = `e1951303-c5ae-4cf6-a407-2b450c6b3720` (first active SIM party
alphabetically — verified). The unique indexes are `(org_id, name)` on
profiles/schedules and `(org_id, mandate_reference)` on mandates, so the
names/references below must stay unique per org — they are namespaced
`VIEWSPEC`.

```sql
  -- Payment-operations setup rows: one per empty view (profiles,
  -- schedules, mandates) plus the approved party bank account the mandate
  -- join requires. Formats already has 8 seeded rows. Fixed ids in the
  -- fresh …9001 block; plain ON CONFLICT is idempotent here (no user
  -- triggers on these tables; the sole CHECK only constrains retired
  -- bank-account rows).
  insert into party_bank_accounts
    (id, org_id, party_id, bank_name, country, currency, routing,
     account_last_four, approved_at, approval_status, is_active)
  values
    ('00000000-0000-7000-9000-000000009001', v_org,
     'e1951303-c5ae-4cf6-a407-2b450c6b3720', 'VIEWSPEC Bank', 'US', 'USD',
     '{}', '4242', CURRENT_DATE, 'approved', true)
  on conflict (id) do nothing;

  insert into payment_bank_profiles
    (id, org_id, name, bank_account_id, payment_format_id, currency,
     require_run_approval, require_file_approval, auto_remittance,
     is_active)
  values
    ('00000000-0000-7000-9000-000000009002', v_org, 'VIEWSPEC profile',
     'a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e',
     '01a083e6-dcad-7860-83c3-a761cb99a3e3', 'CAD',
     true, false, false, true)
  on conflict (id) do nothing;

  insert into payment_schedules
    (id, org_id, name, payment_bank_profile_id, cron, timezone,
     selection_criteria, action, next_run_at, is_active)
  values
    ('00000000-0000-7000-9000-000000009003', v_org, 'VIEWSPEC schedule',
     '00000000-0000-7000-9000-000000009002', '0 8 * * 1', 'UTC',
     '{}', 'create_draft', now() + interval '7 days', true)
  on conflict (id) do nothing;

  insert into payment_mandates
    (id, org_id, party_id, party_bank_account_id, scheme,
     mandate_reference, status, signed_on, valid_from)
  values
    ('00000000-0000-7000-9000-000000009004', v_org,
     'e1951303-c5ae-4cf6-a407-2b450c6b3720',
     '00000000-0000-7000-9000-000000009001', 'sepa_core',
     'VIEWSPEC-MANDATE-1', 'active', CURRENT_DATE, CURRENT_DATE)
  on conflict (id) do nothing;
```

Expected post-fixture counts in the harness org (for the coordinator's
spot-check): profiles 1, schedules 1, mandates 1 (status `active`),
approved party bank accounts ≥1, formats unchanged at 8. The profile and
schedule rows are `is_active`, so `?state=archived` stays empty on those
views while `?state=active` returns exactly the fixture row; the mandate
row answers `?state=active` only.

## 5. Could not express (and why)

Nothing structural — every gap closed with the three registry entries
above. Three residual notes:

1. The editor drawer renders through `payment-operations-editor` (whole
   shared `SetupEditor`) rather than as spec blocks, so the per-view
   field sets, the originator-secrets block, the preset pills, and the
   save flow are covered only via the portaled-drawer scopes, not as
   spec blocks. The `?row=new` create variant renders the same drawer
   with `row: null` and is likewise drawer-scope only.
2. The schedules `next_run_at` MUST stay a raw ISO passthrough with a
   client-side widget cell: the native formats it with the browser's
   `toLocaleString()`, and any server formatting (loader or renderer)
   would diverge by locale/timezone. Do not "simplify" this into a text
   cell.
3. `?view=<unknown>` falls back to profiles and `?row=<non-uuid>` is
   ignored — both are loader behavior with no visible variant (the URL
   stays as typed while the profiles table renders). The harness cannot
   distinguish them from the default render; they are noted here so the
   fallback is not mistaken for missing coverage.
