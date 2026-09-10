# /property-management ViewSpec integration handoff

Page: `web/app/(app)/property-management/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the only component is the existing
`PropertyManagementWorkspace`, reused whole (same shape as the
`/admin/setup/labor-costing` conversion).

Spec shape: `list` layout (the native page renders `ListPageLayout` with a
`PageHeader` + the workspace as its body), one `page-header` block with NO
actions, and one `property-management-workspace` widget block. The loader
does every server decision the native page made; only plain data crosses
the spec.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (check the import block first — nothing below collides
with an existing import; verified by grep: no `PropertyManagement`
hits in the registry file):

```tsx
import { PropertyManagementWorkspace } from '../../app/(app)/property-management/PropertyManagementWorkspace'
```

Entry:

```tsx
/**
 * The whole PropertyManagementWorkspace client island: health metrics, the
 * four-tab strip (properties / rent roll / CAM / deposit reconciliation),
 * the four tab bodies, and all twelve drawers (property, property-detail,
 * unit, unit-record, lease, CAM, CAM-correction, lease-record). Every tab
 * switch, drawer open/close, fetch (GET/POST /api/property-management) and
 * mutation owns `useState`, so the workspace arrives whole — decomposing
 * its tab bodies into spec blocks would render the pre-fetch set and strand
 * the tab state from what it shows (the /reports lesson, also documented on
 * the labor-costing page). The LOADER makes every data decision (gates,
 * subsidiary scope, form layout, list view, option pickers, permission
 * flags, feature probes); the widget only renders. No remount key: the
 * native page renders the workspace keyless.
 *
 * EXACT prop shape: FIVE FLAT props — `customization`, `options`,
 * `permissions`, `fixedAssetsEnabled`, `multiCurrency` — spread directly,
 * exactly as the native page passes them. There is no nested `workspace`
 * bag; do not wrap them in one.
 */
'property-management-workspace': (props) => (
  <PropertyManagementWorkspace {...(props as unknown as ComponentProps<typeof PropertyManagementWorkspace>)} />
),
```

`ComponentProps` is already imported in the registry file. The five props
are all plain JSON-serializable data: `customization.layout` is the
resolved `FormLayoutConfig`, `customization.listView` the resolved
`ListViewConfig`, `fieldDefs`/`forms` plain rows, `options` nine
`{id, name, currency?, partyId?, openBalance?}` arrays, `permissions` five
booleans. No Authz, org id, user id, or bound action crosses the spec.

## 2. Slot proposals (none)

No slot is needed. Authz, org id, user id, subsidiary scope and feature
state are consumed server-side by the loader; only plain data (the
customization object, option lists, booleans) crosses the spec. The
workspace persists mutations through the session cookie inside the shared
component. (Same division as labor-costing §2.)

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/property-management',
  // Whole-workspace page: the loader resolves the header, customization,
  // pickers, permission flags and feature probes; the client island fetches
  // /api/property-management and renders metrics, tabs, tables and drawers.
  // One fixture property (two units, one occupied; one active lease with a
  // base-rent charge; one open CAM pool with a full-share allocation) so
  // the properties table has a row on both paths.
  //
  // ONE variant only. The tab strip and all twelve drawers are client state
  // with no URL affordance, and ?view=/?form= resolve to the single org
  // default layout/view in the harness tenant — a second variant would
  // render byte-identical markup, which assertVariantsDiffer rejects (the
  // /query precedent).
  variants: [''],
  expect: 'table tbody tr',
  minMatches: 1,
},
```

GATES verification (read-only queries against `openbooks_sim_viewspec`,
SIM org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`) — verified against the
page's GATES, not just row counts:

- Permission gate: `requirePermission('ar.read')`. Harness user
  `viewspec@sim.test` (`01a08426-0962-74c7-a086-e1609c589dcb`) holds the
  `admin` role whose `permissions` array contains `"ar.read"` (verified).
  Gate passes. Derived flags for this user, all verified: `manage`/`bill`
  true (`ar.create` present), `account` true (`gl.post` present), `bulk`
  true (admin role's `subsidiary_restriction` is `{"mode": "all"}`, so
  `allowedSubsidiaryIds` resolves null), `customize` true
  (`admin.customization.manage` present).
- Feature gate (TWO layers, both must pass): the segment `layout.tsx` runs
  `requireFeatureEnabled(orgId, 'propertyManagement')` → `notFound()`,
  and `page.tsx` runs `requirePropertyManagementFeature` → redirect to
  `/admin/setup/features`. `propertyManagement` is `defaultEnabled: false`
  (`engine/src/feature-registry.ts:84`) and the harness org's
  `settings->'features'` blob has no `propertyManagement` key (verified),
  so **both branches 404/redirect identically in the harness tenant
  today**. Do NOT register this entry until §4 is applied: the
  `'propertyManagement': true` merge makes the layout gate pass on both
  paths, and only then does the comparison mean anything (the /query
  lesson — comparing two error pages is a false pass).
- Supporting probes are deterministic in the harness tenant either way:
  `multiCurrency` off (default false, no stored key → the subsidiaries
  query selects without `base_currency`), `fixedAssets` on (default true
  + stored true → the assets query runs; zero non-disposed fixed assets in
  the sim org → empty array), one active subsidiary (Main Co), one active
  location (HQ), ≥3 active customers (tenants picker non-empty), income /
  expense / `liability_current_other` / `asset_bank` accounts present.
- List-view resolution: one org-default `property` list view
  (`01a083e6-dcca-745b-8b13-40ce11985cca`, 7 visible columns, currency
  hidden) and one `property` form layout exist in the sim org; zero active
  `managed_properties` custom-field defs. `?view=`/`?form=` with garbage
  fall back to these — loader-resolved data, never spec branches.

Row-count verification: `managed_properties`, `property_units`,
`property_leases` all hold **0 rows** in the sim org today, so
`minMatches: 1` counts the single §4 fixture property. That property's
subsidiary is unrestricted-visible (harness scope is null → no
`subsidiary_id = any(...)` filter), so the row renders for the harness
user.

No logged-out variant is proposed (the harness is always authenticated;
the login redirect is framework behavior, not page content — the
labor-costing precedent).

## 4. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims fresh block **…9801-9899** (verified unused — no `…98xx` id exists
in the file today). Please also add `…9801-9899  property management
(property, units, lease, charge, CAM pool)` to the allocation table at the
top of the file.

Two parts: (a) a `'propertyManagement': true` merge in the existing
"feature switches" block idiom (fixtures.sql:140-150) — WITHOUT it the
page 404s/redirects on both paths (§3); (b) the block below, in the same
`do $$` style as the rest of the file (it uses the ambient `v_org`).

```sql
  -- ---- property management --------------------------------------------------
  --
  -- The simulator never writes managed_properties, so /property-management
  -- renders its empty state on both paths. One property with two units (one
  -- occupied), one active lease with a base-rent charge, and one open CAM
  -- pool with a full-share allocation — so the properties table, the
  -- rent-roll metrics and the CAM tab all have rows. Claims fresh block
  -- …9801-9899 (verified unused).
  --
  -- Guarded by existence, not ON CONFLICT. The
  -- lease_charges_base_rent_no_overlap EXCLUDE constraint cannot serve as an
  -- ON CONFLICT arbiter, so a second run would RAISE on the charge insert
  -- even when every row is a no-op. Idempotence is checked before the
  -- statements, not by them (the labor-pricing precedent in this file).
  declare
    v_sub uuid;
    v_loc uuid;
    v_tenant uuid;
    v_rent_acct uuid;
    v_cam_acct uuid;
    v_dep_acct uuid;
    v_bank_acct uuid;
    v_exp_acct uuid;
    v_starts date := current_date - 60;
    v_ends date := current_date + 300;
  begin
    if not exists (select 1 from managed_properties where id = '00000000-0000-7000-9000-000000009801') then
      select id into v_sub from subsidiaries
       where org_id = v_org and is_active order by name limit 1;
      select id into v_loc from locations
       where org_id = v_org and is_active order by code, name limit 1;
      select p.id into v_tenant from parties p
       join customer_roles c on c.party_id = p.id and c.org_id = p.org_id
       where p.org_id = v_org and p.is_active and c.is_active
       order by p.display_name limit 1;
      select id into v_rent_acct from accounts
       where org_id = v_org and is_active and not is_summary
         and type in ('income', 'income_other') order by number nulls last limit 1;
      select id into v_cam_acct from accounts
       where org_id = v_org and is_active and not is_summary
         and type in ('income', 'income_other') and id <> v_rent_acct
       order by number nulls last limit 1;
      select id into v_dep_acct from accounts
       where org_id = v_org and is_active and not is_summary
         and type = 'liability_current_other' order by number nulls last limit 1;
      select id into v_bank_acct from accounts
       where org_id = v_org and is_active and not is_summary
         and type = 'asset_bank' order by number nulls last limit 1;
      select id into v_exp_acct from accounts
       where org_id = v_org and is_active and not is_summary
         and type in ('expense', 'cogs') order by number nulls last limit 1;
      if v_sub is null or v_tenant is null or v_rent_acct is null
        or v_dep_acct is null or v_bank_acct is null or v_exp_acct is null then
        raise notice 'missing property-management dimensions; skipping property fixtures';
        return;
      end if;

      insert into managed_properties
        (id, org_id, subsidiary_id, location_id, code, name, property_type,
         status, currency, address, custom,
         rent_income_account_id, cam_income_account_id,
         deposit_liability_account_id, default_bank_account_id)
      values
        ('00000000-0000-7000-9000-000000009801', v_org, v_sub, v_loc,
         'PM-VS-1', 'ViewSpec Plaza', 'commercial',
         'active', 'USD', '{}'::jsonb, '{}'::jsonb,
         v_rent_acct, coalesce(v_cam_acct, v_rent_acct),
         v_dep_acct, v_bank_acct);

      insert into property_units
        (id, org_id, property_id, code, name, unit_type, rentable_area, bedrooms, status)
      values
        ('00000000-0000-7000-9000-000000009811', v_org,
         '00000000-0000-7000-9000-000000009801',
         'A-101', 'Suite 101', 'office', 850.5, 0, 'occupied'),
        ('00000000-0000-7000-9000-000000009812', v_org,
         '00000000-0000-7000-9000-000000009801',
         'A-102', 'Suite 102', 'office', 720.0, 0, 'vacant');

      insert into property_leases
        (id, org_id, property_id, unit_id, tenant_id, lease_number, status,
         starts_on, ends_on, billing_day, payment_terms_days,
         security_deposit_required, cam_method, late_fee_type, late_fee_value,
         grace_days, auto_invoice, auto_post)
      values
        ('00000000-0000-7000-9000-000000009821', v_org,
         '00000000-0000-7000-9000-000000009801',
         '00000000-0000-7000-9000-000000009811',
         v_tenant, 'VS-LEASE-1', 'active',
         v_starts, v_ends, 1, 30,
         1000.0000, 'none', 'none', 0,
         5, true, false);

      insert into lease_charges
        (id, org_id, lease_id, charge_type, description, amount, frequency,
         effective_from, effective_to, income_account_id)
      values
        ('00000000-0000-7000-9000-000000009831', v_org,
         '00000000-0000-7000-9000-000000009821',
         'base_rent', 'Base rent', 2500.0000, 'monthly',
         v_starts, null, v_rent_acct);

      insert into cam_pools
        (id, org_id, property_id, name, fiscal_year,
         period_starts_on, period_ends_on, allocation_basis,
         budget_amount, expense_account_ids, status)
      values
        ('00000000-0000-7000-9000-000000009841', v_org,
         '00000000-0000-7000-9000-000000009801',
         'VS CAM 2026', 2026,
         '2026-01-01', '2026-12-31', 'rentable_area',
         12000.0000, jsonb_build_array(v_exp_acct::text), 'open');

      insert into cam_allocations
        (id, org_id, pool_id, lease_id, share_percent,
         budget_allocation, billed_estimate)
      values
        ('00000000-0000-7000-9000-000000009851', v_org,
         '00000000-0000-7000-9000-000000009841',
         '00000000-0000-7000-9000-000000009821',
         100.0000, 12000.0000, 0);
    end if;
  end;
```

Caveats for the coordinator (verified as far as read-only queries allow):

- Unique scopes the block respects: `managed_properties_org_code`
  (`code 'PM-VS-1'`), `property_units_property_code` (`A-101`/`A-102`),
  `property_leases_org_number` (`VS-LEASE-1`),
  `cam_pools_property_year_name` (`VS CAM 2026`/2026),
  `cam_allocations_pool_lease`. The `ON CONFLICT`-useless statements are
  the `lease_charges` insert (EXCLUDE constraint — hence the whole-block
  guard) and, on re-run, nothing else: the guard skips the block before
  any statement. `ON CONFLICT` is deliberately NOT used inside the guard.
- The `cam_pool_source_account_guard` BEFORE trigger fires on the pool
  insert but passes: no other non-cancelled pool on this property shares
  the expense account (the property is fixture-new).
- `security_deposit_transactions` and `lease_escalations` get NO fixture
  rows: both are append-only (`property_financial_evidence_guard`
  rejects UPDATE/DELETE) and neither is needed — the deposits-held metric
  sums `depositBalance` (zero with no deposit rows) and the rent-roll
  overdue metric sums schedule lines (zero with no schedules). The
  deposit-reconciliation tab renders its empty state on both paths,
  identically.
- `lease_schedule_lines` get NO fixture rows for the same reason (empty
  overdue set on both paths). Seeding a posted-invoice overdue line would
  require a full posted `documents` row plus journal evidence — out of
  proportion for a metric the empty state already pins identically.
- `created_by`/`updated_by` are left null (nullable; the banking fixture
  does the same for seeded rows).
- `v_cam_acct` falls back to `v_rent_acct` via `coalesce` so a tenant with
  a single income account still passes the block's null check.

## 5. What the spec does NOT cover (nothing structural)

- No `sections.tsx`: the page defines no local components the spec needs.
  `Metric`, `Status`, `Empty` etc. in `workspace-ui.tsx` stay inside the
  shared workspace component both paths render — nothing needed moving
  because the native branch already imports the workspace from its home.
- The title/description are hard-coded literals copied verbatim from the
  native `PageHeader` — no message keys invented, and no `t('…')` calls in
  the loader at all (the native page also uses none for these strings).
- No `<section>` is placed by the spec (the metrics `<section>` renders
  inside the workspace with its `grid(..., { as: 'section' })`-equivalent
  native markup intact), no page-owned `<td>` needs `tabular-nums`, and no
  pager is placed by the spec (workspace tables are unpaginated).
- `$root` is never used: the spec has no table or repeat. `layout: 'list'`
  matches the native `ListPageLayout` (NOT `bare` — unlike labor-costing,
  this page has no setup-shell chrome of its own; the list chrome is the
  native shell).
- Drawers need no `drawer`/`emptyAction`/`rowActions` refs: they are client
  state inside the island, not URL-driven flyouts. There is no
  `record-list-view` / `entity-list-view` on this page.
