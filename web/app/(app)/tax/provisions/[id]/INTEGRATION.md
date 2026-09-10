# INTEGRATION — `/tax/provisions/[id]` ViewSpec handoff

Page: one income-tax provision run (rate reconciliation + measured
temporary differences + post button). Files owned by this conversion:

- `web/app/(app)/tax/provisions/[id]/view.ts` — `loadProvisionDetail(sp, id)`
  plus `provisionDetailSpec(data)`.
- `web/app/(app)/tax/provisions/[id]/sections.tsx` — shared section/badge
  components plus a re-export of `ProvisionPostButton` (single
  implementation: the native page keeps importing `./ProvisionPostButton`).
- `web/app/(app)/tax/provisions/[id]/page.tsx` — `__viewspec=1` branch added
  (native branch untouched). `searchParams` is optional only so the existing
  direct test invocations passing `{ params }` alone keep compiling; Next.js
  always supplies both in production.
- `web/app/(app)/tax/provisions/[id]/ProvisionPostButton.tsx` — untouched.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

Imports to add:

```tsx
import {
  ProvisionDifferencesSection,
  ProvisionFrameworkBadge,
  ProvisionPostButton,
  ProvisionReconSection,
  ProvisionStatusBadge,
} from '../../app/(app)/tax/provisions/[id]/sections'
```

Entries (proposed location: near the other tax entries, e.g. after the
`tax-page` / `tax-filing-drawer` block from the `/tax` conversion):

```tsx
/* --- tax provision detail -------------------------------------------------- */
/**
 * One income-tax provision run. Both sections stay widgets (the admin-users
 * precedent): the native page hand-rolls two plain `<table>`s with their own
 * header, divider and hover classes, and the spec's table block deliberately
 * offers only the two real table variants the app has. Every string below
 * arrives loader-formatted — money via the tenant's getMoneyFormatter,
 * percents as raw engine strings — so the entries only bind props.
 */
'provision-recon-section': (props) => (
  <ProvisionReconSection
    title={str(props, 'title') ?? ''}
    pretaxLabel={str(props, 'pretaxLabel') ?? ''}
    pretaxAmount={str(props, 'pretaxAmount') ?? ''}
    enactedRateText={str(props, 'enactedRateText') ?? ''}
    amountLabel={str(props, 'amountLabel') ?? ''}
    percentLabel={str(props, 'percentLabel') ?? ''}
    steps={(props.steps as ComponentProps<typeof ProvisionReconSection>['steps']) ?? []}
    summaries={(props.summaries as ComponentProps<typeof ProvisionReconSection>['summaries']) ?? []}
  />
),
/**
 * Measured temporary differences. The empty note lives INSIDE the shared
 * component (not as a spec-level `empty-state`) because the native empty
 * path keeps the section chrome — the h2 and card — and renders the italic
 * note inside it.
 */
'provision-differences-section': (props) => (
  <ProvisionDifferencesSection
    title={str(props, 'title') ?? ''}
    emptyNote={str(props, 'emptyNote') ?? ''}
    columns={
      (props.columns as ComponentProps<typeof ProvisionDifferencesSection>['columns']) ?? {
        item: '',
        bookBasis: '',
        taxBasis: '',
        difference: '',
        effect: '',
      }
    }
    differences={(props.differences as ComponentProps<typeof ProvisionDifferencesSection>['differences']) ?? []}
  />
),
/** The run status badge. The variant map (draft → secondary,
 *  posted → success, superseded → outline) is loader-computed; the entry
 *  only binds the resolved label + variant. Renders the same `@openbooks/ui`
 *  Badge the native header uses. */
'provision-status-badge': (props) => (
  <ProvisionStatusBadge
    label={str(props, 'label') ?? ''}
    variant={(str(props, 'variant') ?? 'secondary') as 'success' | 'secondary' | 'outline'}
  />
),
/** The framework badge, always `outline` on the native path. */
'provision-framework-badge': (props) => <ProvisionFrameworkBadge label={str(props, 'label') ?? ''} />,
/** Posts the run via POST /api/tax/provisions/:id/post, then refreshes.
 *  Flat props: `{ runId: string }` — NOT nested under a `props` key.
 *  The `when: canPost` lives on the spec's widget ref (loader-derived:
 *  gl.post + unrestricted + draft); WidgetSlot renders nothing when off,
 *  so the no-permission header matches the native one exactly. */
'provision-post-button': (props) => <ProvisionPostButton runId={str(props, 'runId') ?? ''} />,
```

## 2. Proposed conformance entry (`scripts/viewspec-conformance.mjs`)

The page takes no query params — its branches are per-run, so the variants
are three fixture runs. No `minMatches` below is measured yet (the SIM tenant
currently holds ZERO `tax_provision_runs` / `temporary_differences`, so the
counts are predictions from the §3 fixture — the coordinator must verify
against the live DB before locking them in):

```js
// Provision run detail has no query params — its branches are per-run, so
// one entry per fixture run (variants are query-only in the harness).
// The IAS 12 draft shows the post button, the seeded recon steps and the
// DTA-recognition-adjustment summary label; the ASC 740 draft has no
// measured differences (italic empty note, no difference rows); the posted
// run hides the button (its recon rows + the empty differences note remain).
{
  path: '/tax/provisions/00000000-0000-7000-9000-000000006901',
  variants: [{ query: '', expect: 'main section table tbody tr', minMatches: 9 }],
  expect: 'main section table tbody tr',
  minMatches: 9,
},
{
  path: '/tax/provisions/00000000-0000-7000-9000-000000006902',
  variants: [{ query: '', expect: 'main section table tbody tr', minMatches: 4 }],
  expect: 'main section table tbody tr',
  minMatches: 4,
},
{
  path: '/tax/provisions/00000000-0000-7000-9000-000000006903',
  variants: [{ query: '', expect: 'main section table tbody tr', minMatches: 5 }],
  expect: 'main section table tbody tr',
  minMatches: 5,
},
```

GATES verification (read-only queries against `openbooks_sim_viewspec`):

- `requirePermission('reports.read')` — harness user `viewspec@sim.test`
  holds the `admin` role, whose permission set includes `reports.read`,
  `reports.create` and `gl.post` (verified: permissions array read from
  `app_roles` for the harness org `da472d3a-…`).
- Subsidiary fence — the harness `admin` role carries
  `subsidiary_restriction {"mode": "all"}` (verified), i.e. unrestricted ⇒
  `allowedSubsidiaryIds` is null ⇒ no 404, and `canPost` reduces to
  `gl.post && draft`.
- `gl.post` — the same `admin` permission set includes `gl.post` (verified),
  so the two draft fixtures render the post button and the posted one does
  not. `canPost` has no other branch: `allowedSubsidiaryIds === null` is
  fixed for this user and `status === 'draft'` varies per run.
- Row counts — the SIM tenant holds ZERO runs/differences today (verified),
  so post-fixture counts equal the fixture counts exactly: draft IAS 12 run
  = 1 pretax row + 5 recon steps + 3 difference rows = 9
  `section table tbody tr`; ASC 740 draft with no differences =
  1 + 3 + 0 = 4 (empty note, no diff rows); posted run =
  1 + 4 + 0 = 5 (its differences are unseedable — trigger-immutable —
  so it renders the empty note too), no post button.
- `assertVariantsDiffer` — the three variants render distinct markup
  (DTA-recognition-adjustment vs valuation-allowance label, empty note vs
  difference rows, button present vs absent). A fourth variant cannot differ
  from these three: the only remaining branches are the IAS 12/ASC 740
  framework badge text (inside variant 1 vs 2/3) and `superseded` vs
  `posted` badge variant — a `superseded` run needs a posted run + journal
  lineage the fixture cannot cheaply build, and its markup differs from
  `posted` only in badge copy.

## 3. Fixture SQL (for the coordinator — append to `scripts/viewspec-fixtures.sql`)

Fresh block claimed: `…6901-6919` (no existing fixture id uses the
`0000069xx` range — verified by enumerating every
`00000000-0000-7000-9000-00000…` id in the file; the tax block stops at
`…6813` and the next claimed range starts at `…7801`).

Three runs: an IAS 12 draft with steps + differences (post button visible),
an ASC 740 draft with steps but NO differences (empty-note branch), and a
posted run with steps + differences (button hidden). Fiscal years differ per
run (partial unique index `tax_provision_runs_one_draft_per_fy` allows only
one draft per org + year; `tax_provision_runs_org_fy_version` is unique on
org + year + version).

GUARD before each run insert: the partial unique indexes above are on
`(org_id, fiscal_year)` / `(org_id, fiscal_year, version)`, NOT the id — so
`ON CONFLICT (id) DO NOTHING` alone would raise on a re-run against a row
holding the same year, and the history-guard trigger
(`protect_tax_provision_history`) makes UPDATEs of finalized runs fail. The
`where not exists` guards own idempotence. The differences insert targets
BEFORE the update (draft-status rows only — the temp-difference history
guard rejects writes against non-draft runs) and carries its own
`where not exists` guard for the same reason; plain `ON CONFLICT (id)` is
safe there (bare PK, no partial index) but the guard keeps both halves in
the same style.

```sql
  -- ---- income-tax provision detail (/tax/provisions/[id]) ------------------
  -- Three runs: an IAS 12 draft (post button + differences), an ASC 740
  -- draft with NO differences (italic empty-note branch), and a posted run
  -- (button hidden). GUARDs before inserts: the one-draft-per-year partial
  -- unique index is on (org_id, fiscal_year), not the id, and finalized
  -- runs are trigger-immutable — ON CONFLICT (id) alone cannot own
  -- idempotence here.
  insert into tax_provision_runs
    (id, org_id, fiscal_year, period_from, period_to, status, version,
     snapshot_hash, payload)
  select '00000000-0000-7000-9000-000000006901', v_org, 2026,
         '2026-01-01', '2026-12-31', 'draft', 1, repeat('d', 64),
         jsonb_build_object(
           'fiscalYear', 2026, 'framework', 'ias12',
           'pretaxBookIncome', '500000.00', 'enactedRatePercent', '21',
           'taxableIncome', '480000.00', 'currentTax', '100800.00',
           'deferredExpense', '4200.00', 'totalExpense', '105000.00',
           'balances', jsonb_build_object(
             'dtaGross', '35000.00', 'dtlGross', '30000.00',
             'valuationAllowance', '9000.00'),
           'rateReconciliation', jsonb_build_array(
             jsonb_build_object('key', 'statutory', 'label', 'Statutory tax', 'amount', '105000.00', 'percent', '21'),
             jsonb_build_object('key', 'credits', 'label', 'Tax credits', 'amount', '-8000.00', 'percent', '-1.6'),
             jsonb_build_object('key', 'va', 'label', 'Recognition adjustment', 'amount', '9000.00', 'percent', '1.8'),
             jsonb_build_object('key', 'other', 'label', 'Other', 'amount', '-1000.00', 'percent', null),
             jsonb_build_object('key', 'total', 'label', 'Total income tax expense', 'amount', '105000.00', 'percent', '21')))
   where not exists (select 1 from tax_provision_runs
                      where org_id = v_org and fiscal_year = 2026 and version = 1);

  insert into tax_provision_runs
    (id, org_id, fiscal_year, period_from, period_to, status, version,
     snapshot_hash, payload)
  select '00000000-0000-7000-9000-000000006902', v_org, 2025,
         '2025-01-01', '2025-12-31', 'draft', 1, repeat('e', 64),
         jsonb_build_object(
           'fiscalYear', 2025, 'framework', 'asc740',
           'pretaxBookIncome', '200000.00', 'enactedRatePercent', '21',
           'taxableIncome', '200000.00', 'currentTax', '42000.00',
           'deferredExpense', '0.00', 'totalExpense', '42000.00',
           'balances', jsonb_build_object(
             'dtaGross', '0.00', 'dtlGross', '0.00',
             'valuationAllowance', '0.00'),
           'rateReconciliation', jsonb_build_array(
             jsonb_build_object('key', 'statutory', 'label', 'Statutory tax', 'amount', '42000.00', 'percent', '21'),
             jsonb_build_object('key', 'other', 'label', 'Other', 'amount', '0.00', 'percent', null),
             jsonb_build_object('key', 'total', 'label', 'Total income tax expense', 'amount', '42000.00', 'percent', '21')))
   where not exists (select 1 from tax_provision_runs
                      where org_id = v_org and fiscal_year = 2025 and version = 1);

  insert into tax_provision_runs
    (id, org_id, fiscal_year, period_from, period_to, status, version,
     snapshot_hash, payload, journal_entry_id, posted_at, posted_by)
  select '00000000-0000-7000-9000-000000006903', v_org, 2024,
         '2024-01-01', '2024-12-31', 'posted', 1, repeat('f', 64),
         jsonb_build_object(
           'fiscalYear', 2024, 'framework', 'asc740',
           'pretaxBookIncome', '300000.00', 'enactedRatePercent', '21',
           'taxableIncome', '290000.00', 'currentTax', '60900.00',
           'deferredExpense', '2100.00', 'totalExpense', '63000.00',
           'balances', jsonb_build_object(
             'dtaGross', '12000.00', 'dtlGross', '10000.00',
             'valuationAllowance', '100.00'),
           'rateReconciliation', jsonb_build_array(
             jsonb_build_object('key', 'statutory', 'label', 'Statutory tax', 'amount', '63000.00', 'percent', '21'),
             jsonb_build_object('key', 'perm', 'label', 'Permanent differences', 'amount', '-2100.00', 'percent', '-0.7'),
             jsonb_build_object('key', 'other', 'label', 'Other', 'amount', '2100.00', 'percent', null),
             jsonb_build_object('key', 'total', 'label', 'Total income tax expense', 'amount', '63000.00', 'percent', '21'))),
         '00000000-0000-7000-9000-000000006909',
         timestamptz '2025-03-15 12:00:00+00', v_user
   where not exists (select 1 from tax_provision_runs
                      where org_id = v_org and fiscal_year = 2024 and version = 1);

  -- Differences for the IAS 12 draft only (3 rows: auto + manual + a
  -- null-percent sibling). The ASC 740 draft gets NONE — it is the empty-note
  -- variant. The posted run ALSO gets none: the temp-difference history
  -- trigger (`protect_temporary_difference_history`) rejects ANY insert
  -- against a non-draft run (verified: attempted insert raises
  -- 'temporary differences are immutable after provision finalization'),
  -- so a posted run with seeded differences is unseedable — the posted
  -- variant exercises the hidden post button + recon rows instead.
  -- `subsidiary_id` is left null (nullable, and the SIM org has a single
  -- subsidiary the harness user sees anyway). Guard before insert: the same
  -- trigger requires the parent run to exist with status `draft`, so the
  -- guard owns idempotence on re-runs.
  insert into temporary_differences
    (id, org_id, run_id, category, description, book_basis, tax_basis,
     difference, rate_percent, tax_effect, source)
  select v.id::uuid, v_org, '00000000-0000-7000-9000-000000006901',
         v.category, v.description, v.book_basis::numeric, v.tax_basis::numeric,
         v.difference::numeric, v.rate_percent::numeric, v.tax_effect::numeric, v.source
    from (values
      ('00000000-0000-7000-9000-000000006911', 'fixed_assets',
       'Accelerated depreciation', '120000.00', '80000.00', '40000.00', '21', '8400.00', 'auto'),
      ('00000000-0000-7000-9000-000000006912', 'provisions',
       'Warranty reserve', '15000.00', '0.00', '15000.00', '21', '3150.00', 'manual'),
      ('00000000-0000-7000-9000-000000006913', 'loss_carryforward',
       'NOL carryforward', '0.00', '42857.14', '-42857.14', '21', '-9000.00', 'manual')) as v(id, category, description, book_basis, tax_basis, difference, rate_percent, tax_effect, source)
   where (select status from tax_provision_runs
           where id = '00000000-0000-7000-9000-000000006901') = 'draft'
     and not exists (select 1 from temporary_differences
                      where id in ('00000000-0000-7000-9000-000000006911',
                                   '00000000-0000-7000-9000-000000006912',
                                   '00000000-0000-7000-9000-000000006913'));

  -- (No differences insert for the posted run: the history trigger forbids
  -- it. Its variant is recon-rows + empty-note + no post button.)
```

Constraint notes (all verified against the live sim schema):

- `tax_provision_runs_status_chk` allows `draft/discarded/posted/superseded` ✓.
- `tax_provision_runs_lifecycle_shape_chk`: `draft` ⇔ `journal_entry_id`,
  `posted_at`, `posted_by` ALL NULL; `posted` ⇔ all NOT NULL ✓ (the posted
  fixture sets all three; drafts leave all null).
- Unique: `(org_id, fiscal_year) WHERE status='draft'`,
  `(org_id, fiscal_year) WHERE status='posted'`,
  `(org_id, fiscal_year, version)` — years 2026/2025/2024 differ ✓.
- `journal_entry_id` has NO FK (verified: zero FK constraints on the table),
  so the placeholder `…6909` needs no journal row ✓. But it IS covered by
  unique `tax_provision_runs_journal_lineage (org_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL` — the `…6909` value is in the claimed
  fresh block, no collision ✓.
- `snapshot_hash` is NOT NULL with no format CHECK ✓ (`repeat('x',64)`).
- `temporary_differences_category_chk` / `_source_chk` ✓ (all values from
  the allowed sets).
- `temporary_differences.subsidiary_id` is nullable ✓ (left null).
- History-guard triggers: `tax_provision_history_guard` (UPDATE/DELETE on
  runs) and `temporary_difference_history_guard` (INSERT/UPDATE/DELETE on
  differences, requires the parent run to exist with status `draft` —
  enforced by the `where (select status …) = …` guard, which makes a
  re-run a no-op rather than an exception). Fresh ids + `where not exists`
  mean a re-run inserts nothing and updates nothing ✓.
- `created_by`/`posted_by` are nullable; `posted_by` uses the harness user
  `v_user` (`viewspec@sim.test`) following the approvals-block precedent.
  NOTE: the approvals block declares `v_user` in its own nested `declare`,
  so it is out of scope here — this block must either sit inside a `declare
  v_user uuid; begin select id into v_user … end;` wrapper of its own (same
  pattern as the approvals block) or inline
  `(select id from users where org_id = v_org and email =
  'viewspec@sim.test')` for `posted_by`.

## 4. What the spec does NOT cover (deliberate, documented)

- No `table` blocks: both tables are hand-rolled markup (the admin-users
  precedent) with nonstandard header cells (`<th className="py-1">`, no
  card/hover/dividers). Shared components, same reason the tax history
  table stayed a component.
- No `frame('tab-content')` / `frame('card')`: the sections render their own
  `<section className="rounded-xl border …">` card chrome inside the shared
  components. A grid `as: 'section'` would need the card classes as the
  grid className with the heading+tables as children — but the heading and
  tables are inseparable parts of each section's markup (the empty-note
  conditional pair lives inside the differences section), so splitting them
  into spec-level blocks buys nothing over the widget boundary.
- No `layout: 'bare'` / `repeat.unwrapped`: the body is a single
  `grid('grid gap-6 lg:grid-cols-2', …)` — a plain div with the native class
  string verbatim — matching the native `<div className="grid gap-6
  lg:grid-cols-2">` exactly (verified: the grid renderer emits a bare div
  with exactly that className; the widget renderer emits a Fragment).
- Nothing else is unexpressed. Authz decisions (`canPost`), the subsidiary
  404 fence, status-variant mapping, framework copy, money formatting, and
  the `total`-step label override are all loader-derived data; the slot rule
  is satisfied trivially (the page needs no org/user id at render time —
  the post button POSTs to the route, which re-derives authz server-side).
