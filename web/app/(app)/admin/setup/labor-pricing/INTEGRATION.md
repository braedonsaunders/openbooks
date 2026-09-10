# /admin/setup/labor-pricing ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/labor-pricing/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. The island itself (`../labor-costing/LaborBillRateCards`, owned
by the labor-costing surface) is untouched; both render paths share it
through `sections.tsx`.

Spec widgets used: `labor-pricing-heading`, `labor-pricing-view` (both
proposed below — neither exists in the registry yet). The docs ghost button
is part of the heading component, not `docs-link-button` (see §4).

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (both components already exist as shared implementations
in this page's `sections.tsx`):

```tsx
import {
  LaborPricingHeading,
  LaborPricingView,
} from '../../app/(app)/admin/setup/labor-pricing/sections'
```

Entries:

```tsx
/* --- labor pricing -------------------------------------------------------- */
/**
 * The page heading: hand-rolled h2 + description with the ghost docs
 * action — not `pageHeader` (whose title row, back-link slot and sticky
 * geometry are a different element) and not `docs-link-button` (outline,
 * no space after the icon). Page-owned, like the receipts strip.
 */
'labor-pricing-heading': (props) => (
  <LaborPricingHeading
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    docsHref={str(props, 'docsHref') ?? '/docs/labor-pricing'}
    docsLabel={str(props, 'docsLabel') ?? ''}
  />
),
/**
 * Passed whole, like the approvals table and the file list: the toolbar
 * selects navigate with `router.push`, rows open on click, the create
 * button POSTs, and the drawer edits drafts in local state before PUT-ing —
 * client behavior a spec cannot name. The hand-rolled rate-book table is
 * not the shared app table either, so there is nothing to decompose into.
 * Every prop is loader-resolved data (org/user/roles stay server-side in
 * the loader and the form-layout call); the entry only binds it.
 */
'labor-pricing-view': (props) => (
  <LaborPricingView
    cards={(props.cards as ComponentProps<typeof LaborPricingView>['cards']) ?? []}
    selected={(props.selected as ComponentProps<typeof LaborPricingView>['selected']) ?? null}
    creating={props.creating === true}
    total={Number(props.total ?? 0)}
    page={Number(props.page ?? 1)}
    perPage={Number(props.perPage ?? 25)}
    currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    timeFilter={
      props.timeFilter === 'scheduled' || props.timeFilter === 'expired' || props.timeFilter === 'all'
        ? props.timeFilter
        : 'active'
    }
    dimensionFilter={str(props, 'dimensionFilter') ?? 'all'}
    items={(props.items as ComponentProps<typeof LaborPricingView>['items']) ?? []}
    timeTypes={(props.timeTypes as ComponentProps<typeof LaborPricingView>['timeTypes']) ?? []}
    options={(props.options as ComponentProps<typeof LaborPricingView>['options']) ?? {}}
    currencies={(props.currencies as string[]) ?? []}
    multiCurrency={props.multiCurrency === true}
    layout={props.layout as ComponentProps<typeof LaborPricingView>['layout']}
    forms={(props.forms as ComponentProps<typeof LaborPricingView>['forms']) ?? []}
    currentFormId={str(props, 'currentFormId') ?? null}
    customFieldDefs={(props.customFieldDefs as ComponentProps<typeof LaborPricingView>['customFieldDefs']) ?? []}
    canCustomize={props.canCustomize === true}
  />
),
```

Why two entries and not one: the heading is static server markup the spec
can place and gate independently of the island; the island is one client
component that takes the whole loader result as props.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (all rows below belong to the
harness org `da472d3a-…`; the harness user is `viewspec@sim.test` with the
admin role, which carries `admin.setup.manage` and `admin.customization.manage`;
the `projects` feature is on for the harness org, so no redirect):

```js
{
  path: '/admin/setup/labor-pricing',
  // One rate-book list behind two filters, plus the card flyout. The
  // fixtures below seed two ACTIVE books (one scoped, one unscoped) and one
  // EXPIRED book, so the default (active) render carries 2 rows, the expired
  // filter carries 1, and the unscoped-dimension filter carries 1 of the 2
  // active ones — every variant renders different rows, which is what the
  // identical-markup guard demands.
  variants: [
    '',
    { query: '?time=expired', expect: 'table tbody tr', minMatches: 1 },
    {
      query: '?dimension=unscoped',
      expect: 'table tbody tr',
      minMatches: 1,
    },
    {
      query: '?card=00000000-0000-7000-9000-000000007811',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      // The flyout is portaled to <body>, so it has to be named explicitly
      // or the comparison never looks at it.
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Row-count verification (read-only queries; tenant currently holds ZERO
`item_rate_books` / `item_rate_versions`, so post-fixture counts equal the
fixture counts exactly):

- Default (`active` filter): versions `…7811` (status `active`,
  `effective_from` 2025-01-01, `effective_to` null ⇒ covers business-today
  on any real run date) and `…7812` (status `active`, 2024-01-01→null) ⇒
  **2 rows**. Version `…7813` is `retired` with `effective_to` 2024-06-30,
  so the active predicate (`status = 'active' and from <= today and
  (to is null or to >= today)`) excludes it.
- `?time=expired`: predicate `(status = 'retired' or effective_to < today)`
  ⇒ only `…7813` ⇒ **1 row**, different rows from the default.
- `?dimension=unscoped`: predicate `not exists (scopes …)` ⇒ `…7812`
  (no scope rows) but NOT `…7811` (has a department scope) ⇒ **1 row**,
  a strict subset of — hence different markup from — the default.
  (The `subsidiary` dimension value is correctly ABSENT from the filter:
  the sim tenant has exactly 1 active non-elimination subsidiary, so
  `subsidiaryFeatureEnabled` resolves false and the option list omits it —
  the loader computes this, both paths share it.)
- Drawer id `…7811` is the scoped active version in the harness org —
  passes the `isUuid` + org guard — with one scope row, one adjustment
  (with a text target), one term and one line, so the drawer's scopes /
  adjustments / terms / lines aggregates each render one entry. `canFile`
  analogues (`canCustomize`) are true for the admin harness user.
- `assertVariantsDiffer` holds: 2-row table vs 1-row expired table vs
  1-row unscoped table vs table + portaled drawer are four distinct
  markups. No `?dimension=<type>` variant is proposed: with the fixture
  above only `department` would match exactly one row, and a second
  near-duplicate variant adds no branch the `unscoped` variant does not
  already exercise.

GATES (all verified read-only against the sim tenant):

- `admin.setup.manage` — in the admin role's permission set.
- `requireProjectsFeature` — `settings.features.projects` is `true` for
  the harness org (read from `orgs.settings`), so no redirect to
  `/admin/setup/features` on either path.

## 3. Fixture SQL (for the coordinator — append to `scripts/viewspec-fixtures.sql`)

Fresh block claimed: `…7801-7899` (no existing fixture id uses the
`0000078xx` range — verified by enumerating every
`00000000-0000-7000-9000-00000…` id in the file). Insert order follows the
FK chain (books → versions → policies/scopes/items/lines/adjustments/
targets/terms). `created_by`/`updated_by` are nullable throughout and are
left unset, as elsewhere in this file. `custom` on versions defaults to
`'{}'` (omitted). All rows target `v_org`, resolved once at the top of the
existing `do` block.

`today` for the effective predicates is `businessToday` (the org's business
day; UTC day when no zone is set) evaluated at harness-run time. The two
active versions use open-ended ranges (`effective_from` 2025-01-01 /
2024-01-01, `effective_to` null) that contain any plausible run date; the
expired version is `retired` with `effective_to` 2024-06-30, which also
satisfies the `effective_to < today` disjunct, so its row is reachable by
both halves of the expired predicate.

The active-overlap exclusion constraint
(`no_active_overlap` on `(org_id, rate_book_id, daterange) where status =
'active'`) applies per RATE BOOK: the two active versions sit on different
books (`…7801`, `…7802`), and the expired version shares book `…7801` with
`…7811` but is `retired`, so the exclusion (active-only) does not fire.

```sql
  -- ---- labor pricing ------------------------------------------------------
  --
  -- Bill rate books + versions for the /admin/setup/labor-pricing
  -- conversion: two ACTIVE books (one department-scoped, one unscoped) and
  -- one EXPIRED book, so the time and dimension filters each change the
  -- result set (see the INTEGRATION.md for that page). The drawer variant
  -- opens the scoped version with one scope, one adjustment, one term and
  -- one line.
  insert into item_rate_books (id, org_id, code, name, currency, is_active)
  values
    ('00000000-0000-7000-9000-000000007801', v_org, 'STD-2025', 'Standard bill rates', 'USD', true),
    ('00000000-0000-7000-9000-000000007802', v_org, 'OT-2025', 'Overtime bill rates', 'USD', true)
  on conflict (id) do nothing;

  insert into item_rate_versions (id, org_id, rate_book_id, effective_from, effective_to, status)
  values
    ('00000000-0000-7000-9000-000000007811', v_org, '00000000-0000-7000-9000-000000007801', '2025-01-01', null, 'active'),
    ('00000000-0000-7000-9000-000000007812', v_org, '00000000-0000-7000-9000-000000007802', '2024-01-01', null, 'active'),
    ('00000000-0000-7000-9000-000000007813', v_org, '00000000-0000-7000-9000-000000007801', '2024-01-01', '2024-06-30', 'retired')
  on conflict (id) do nothing;

  insert into labor_rate_version_policies (id, org_id, version_id, derivation_policy)
  values
    ('00000000-0000-7000-9000-000000007821', v_org, '00000000-0000-7000-9000-000000007811', 'explicit'),
    ('00000000-0000-7000-9000-000000007822', v_org, '00000000-0000-7000-9000-000000007812', 'explicit'),
    ('00000000-0000-7000-9000-000000007823', v_org, '00000000-0000-7000-9000-000000007813', 'explicit')
  on conflict (id) do nothing;

  -- One department scope on the drawer version only (makes ?dimension=unscoped
  -- a strict subset of the default). The department is fixture-owned so the
  -- scope-label subselect resolves a name rather than null.
  insert into departments (id, org_id, code, name, is_active)
  values ('00000000-0000-7000-9000-000000007831', v_org, 'FIELD', 'Field operations', true)
  on conflict (id) do nothing;

  insert into labor_rate_version_scopes (id, org_id, version_id, scope_type, scope_value_id, scope_value_text, include_children)
  values ('00000000-0000-7000-9000-000000007841', v_org, '00000000-0000-7000-9000-000000007811', 'department', '00000000-0000-7000-9000-000000007831', null, false)
  on conflict (id) do nothing;

  -- One billable item + one line on the drawer version (the lines aggregate
  -- joins items, so the item must exist; kind/category feed the picker
  -- dimensions).
  insert into items (id, org_id, name, kind, category, is_active)
  values ('00000000-0000-7000-9000-000000007851', v_org, 'Journeyman electrician', 'labor', 'field', true)
  on conflict (id) do nothing;

  insert into item_rate_lines (id, org_id, version_id, item_id, base_quantity, bill_rate, sort_order)
  values ('00000000-0000-7000-9000-000000007861', v_org, '00000000-0000-7000-9000-000000007811', '00000000-0000-7000-9000-000000007851', 1, 95.00, 1)
  on conflict (id) do nothing;

  -- One adjustment with a free-text target (satisfies the one-value check
  -- via target_value_text) plus one term on the drawer version.
  insert into labor_rate_adjustments
    (id, org_id, version_id, code, name, category, calculation, value, unit,
     presentation, sort_order, is_active, applies_regular, applies_overtime,
     applies_double_time, applies_shift)
  values ('00000000-0000-7000-9000-000000007871', v_org, '00000000-0000-7000-9000-000000007811',
    'NIGHT', 'Night premium', 'surcharge', 'percent', 10.00, 'percent',
    'separate', 1, true, true, true, false, false)
  on conflict (id) do nothing;

  insert into labor_rate_adjustment_targets (id, org_id, adjustment_id, target_type, target_value_id, target_value_text, include_children)
  values ('00000000-0000-7000-9000-000000007881', v_org, '00000000-0000-7000-9000-000000007871', 'other', null, 'Night shift', false)
  on conflict (id) do nothing;

  insert into labor_rate_terms (id, org_id, version_id, code, label, content, placement, sort_order)
  values ('00000000-0000-7000-9000-000000007891', v_org, '00000000-0000-7000-9000-000000007811',
    'NET30', 'Payment terms', 'Net 30 days from invoice date.', 'footer', 1)
  on conflict (id) do nothing;
```

Constraint notes (all verified against the live sim schema):

- `item_rate_versions`: `status` ∈ `draft/active/retired` ✓;
  `effective_to >= effective_from` where non-null ✓; the gist exclusion
  only constrains `active` rows sharing a book — respected (see above) ✓.
- `labor_rate_version_policies`: `derivation_policy` ∈
  `explicit/time_type_multipliers` ✓ (all `explicit`).
- `labor_rate_version_scopes`: `scope_type` ∈ the seven allowed values ✓
  (`department`); exactly one of `scope_value_id`/`scope_value_text`
  non-null ✓.
- `items`: `name`, `kind` non-null; `is_active` defaults true (set
  explicitly anyway) ✓.
- `item_rate_lines`: `base_quantity > 0` ✓ (`1`);
  `bill_rate >= 0` ✓ (`95.00`); `item_id` FK is `(org_id, item_id)` —
  same org ✓.
- `labor_rate_adjustments`: `calculation` ∈
  `percent/fixed/per_hour/per_day/distance/time/text` ✓;
  `category` ∈ `markup/travel/allowance/minimum/surcharge/other` ✓;
  `presentation` ∈ `included/separate/informational` ✓;
  `value >= 0` ✓; `applies_*` non-null booleans ✓;
  `sort_order`/`is_active` non-null ✓.
- `labor_rate_adjustment_targets`: exactly one of
  `target_value_id`/`target_value_text` ✓ (`'Night shift'` text).
- `labor_rate_terms`: `placement` ∈ `header/conditions/footer` ✓;
  `sort_order` non-null ✓.
- `departments`: `UNIQUE (org_id, code)` — fixture code `FIELD` is
  org-scoped and new ✓.

## 4. What the spec does NOT cover (deliberate, documented)

- No `table`/`pagination`/`search-input`/`filter-chips` blocks: the toolbar
  selects navigate with `router.push` (not `FilterChips` navigation), rows
  open on click, and the table is the shared app `Table` inside the client
  island — decomposing it would restyle the page, not convert it.
- No `docs-link-button`: that entry is `variant="outline"` with no space
  after the icon; the native header is `variant="ghost"` with a spaced icon
  (`<BookOpen size={14} aria-hidden /> {label}`). Same-looking buttons that
  are not the same button — the audit entry in the registry says as much.
- No `frame('tab-content')` / drawer `when` at spec level: the island owns
  its drawer (keyed `selected.id:formId`, exactly as native) and the spec
  holds no conditionals — the loader resolves every flag the island reads.
- The `creating` (`?card=new`) branch: `creatingCard` POST state lives in
  the island; the loader passes `creating` through verbatim and both paths
  render the same initial state. No conformance variant opens it (it POSTs
  on click — nothing for the harness to compare).
- `resolveFormLayout` user scoping (`userId`, `userRoles`) stays in the
  loader; the resolved `layout`/`available`/`row.id` travel as data, the
  same treatment the AR invoices drawer gives its form layout.
