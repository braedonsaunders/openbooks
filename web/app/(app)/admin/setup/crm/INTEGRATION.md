# /admin/setup/crm ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/crm/` — owner files are `view.ts` (+ this
file) and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`:
the page defines no local components (see "What the spec does NOT cover"
below).

Spec widgets used: `crm-setup-workspace` (proposed below — does not exist in
the registry yet). Everything else the page renders (tab strip, search, New
button, table, pager, drawer) lives inside that one widget.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (the component already exists):

```tsx
import { CrmSetupWorkspace } from '../../app/(app)/admin/setup/crm/CrmSetupWorkspace'
```

Entry:

```tsx
/* --- crm setup ---------------------------------------------------------------- */
/**
 * The whole page is one client island, passed whole like
 * `labor-costing-workspace` and `labor-pricing-view`: the underline tab
 * strip, the search + New-button toolbar, the per-tab hand-rolled table
 * (rows navigate on click and Enter), the pager and the edit drawer all own
 * client behavior a spec cannot name, and the per-tab column sets are a
 * six-way conditional pair, not presence. A spec `table` block is wrong
 * here twice over: variant 'app' renders different thead/td markup, and it
 * cannot carry row-click routing. Every prop is loader-resolved data (gates,
 * queries, pickers, the ?row= flyout); the entry only binds it.
 *
 * Diffed against the existing entries before writing this one:
 * `entity-list-view`/`record-list-view` are slot-backed universal lists with
 * drawer/emptyAction/rowActions refs — this page's table is per-tab bespoke
 * (six column sets, translated/badge/money cells, search-param-derived
 * closeHref), not the universal list. `setup-section` is one generic setup
 * panel with its own shell contract; it cannot carry six tabbed lists. So a
 * new entry, following the `labor-costing-workspace` spread pattern.
 */
'crm-setup-workspace': (props) => (
  <CrmSetupWorkspace {...(props as unknown as ComponentProps<typeof CrmSetupWorkspace>)} />
),
```

## 2. Fixture SQL (for the coordinator — append to `scripts/viewspec-fixtures.sql`)

Claimed fresh id block `…a000-000000000101` … `…a000-000000000104`
(occupied in the `…a000` range: `…001`, `…002` custom records, `…010` quota,
`…020` snapshot — verified by grep, no collision).

The simulator seeds 9 account statuses, 6 opportunity statuses and 1 quota
for the harness org, but zero lead sources, territories or teams — three of
the six tabs would compare two identical empty states. Two sources, one
territory and one team (with one active member) so those tabs render rows.
Style follows the labor-pricing fixture block (fixed ids,
`ON CONFLICT DO NOTHING`, `v_owner` = oldest harness-org user; trial insert
verified live against `openbooks_sim_viewspec` on 2026-09-10):

```sql
  -- ---- crm setup ----------------------------------------------------------------
  --
  -- Lead sources, one territory and one team for the /admin/setup/crm
  -- conversion. The simulator seeds account statuses (9), opportunity
  -- statuses (6) and one quota for the SIM org but no sources, territories
  -- or teams, so three of the six tabs would compare two identical empty
  -- states. Two sources, one territory and one team (with one active member
  -- so member_count renders 1) close that gap; the account-statuses default
  -- already carries 9 rows and the drawer variant opens the fixture quota
  -- ...a000-...010 from the forecasts block above.
  insert into crm_lead_sources (id, org_id, key, name, description, is_active)
  values
    ('00000000-0000-7000-a000-000000000101', v_org, 'vs-web', 'ViewSpec Web', 'Seeded for the CRM setup conformance tab', true),
    ('00000000-0000-7000-a000-000000000102', v_org, 'vs-referral', 'ViewSpec Referral', 'Seeded for the CRM setup conformance tab', true)
  on conflict (id) do nothing;

  insert into crm_sales_teams (id, org_id, key, name, manager_user_id, is_active)
  values ('00000000-0000-7000-a000-000000000103', v_org, 'vs-team', 'ViewSpec Sales', v_owner, true)
  on conflict (id) do nothing;

  insert into crm_sales_team_members (org_id, team_id, user_id, role, is_active)
  values (v_org, '00000000-0000-7000-a000-000000000103', v_owner, 'manager', true)
  on conflict do nothing;

  insert into crm_sales_territories
    (id, org_id, key, name, description, priority, manager_user_id, default_owner_user_id, match_mode, rules, is_active)
  values ('00000000-0000-7000-a000-000000000104', v_org, 'vs-west', 'ViewSpec West',
    'Seeded for the CRM setup conformance tab', 100, v_owner, v_owner, 'all', '[]'::jsonb, true)
  on conflict (id) do nothing;
```

NOTE: the original `v_owner` in the forecasts block is declared inside that
block's `declare` — this block needs its own `select id into v_owner from
users where org_id = v_org order by created_at limit 1;` if it lands outside
that scope, or reuse the same `declare` block. The trial ran with its own
declare and passed.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` on 2026-09-10 (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`; harness user `viewspec@sim.test`
holds the admin role, which carries `crm.setup.manage`; the harness org has
`settings.features.crm = true`, so no 404; `multiCurrency` resolves false
for the harness org — no fx lines, no fx rates — so the currency picker path
is dormant in both renders, identically):

```js
{
  path: '/admin/setup/crm',
  // Six tabs behind one client island. The default (accountStatuses) carries
  // 9 simulator rows; the sources tab carries the 2 fixture rows (strictly
  // fewer than every other populated tab, so the identical-markup guard
  // cannot trip); the quotas drawer opens the ...010 fixture quota from the
  // forecasts block. The teams tab carries the 1 fixture team and the
  // territories tab the 1 fixture territory — same row count, but the tab
  // strip's active classes and the per-tab columns/search/new labels differ,
  // so ?tab=teams vs ?tab=territories markup is NOT identical.
  variants: [
    '',
    { query: '?tab=sources', expect: 'table tbody tr', minMatches: 2 },
    { query: '?tab=opportunityStatuses', expect: 'table tbody tr', minMatches: 6 },
    {
      query: '?tab=quotas&row=00000000-0000-7000-a000-000000000010',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 9,
},
```

Row-count verification (read-only queries, harness org):

- `crm_account_statuses` → 9 (`New|Working|Qualified|Disqualified|Open| Nurturing|Closed lost|Active|Inactive`, ordered by lifecycle_stage, sequence, name)
- `crm_opportunity_statuses` → 6 (`Qualification|Discovery|Proposal| Negotiation|Closed won|Closed lost`)
- `crm_lead_sources` → 2 fixture (`ViewSpec Referral|ViewSpec Web`, ordered by name)
- `crm_sales_teams` → 1 fixture (`ViewSpec Sales`, member_count 1, manager `Alex Payable` = oldest harness user)
- `crm_sales_territories` → 1 fixture (`ViewSpec West`)
- `crm_sales_quotas` → 1 fixture (`...010`, period 2026-09-01, USD 50000)
- drawer id `...010` passes the org guard (same org) and the uuid guard
- `?tab=bogus` falls back to `accountStatuses` (same 9 rows as default —
  NOT proposed as a variant: the harness rejects variants that cannot differ)

## 4. What the spec does NOT cover (nothing — full coverage by construction)

- No `sections.tsx`: the page defines no local components. `SetupRows`,
  `renderCell`, `CrmSetupDrawer` and all field components live in
  `CrmSetupWorkspace.tsx`, which both render paths share through the widget —
  the same single-implementation rule as the labor-pricing island.
- The drawer open/create/edit tri-state (`creating || selected`) is internal
  to the widget; the loader supplies `selected` + `creating` verbatim and the
  `key={tab:selected?.id}` remount rides along.
- `closeHref`/`newParams` are `useSearchParams`-derived inside the widget, so
  the loader does NOT rebuild them — rebuilding URL state from `sp` in the
  loader while the widget also derives it would fork the two renders. (This
  differs from the setup-entity conversion, whose drawer hrefs are loader
  data; here the drawer is part of the island.)
- Money, badges and translated enums render client-side inside the shared
  component — no server formatting to drift. The `useMoney` provider comes
  from the `(app)` layout, which wraps both paths.
- GATES (not just row counts): `crm.setup.manage` (harness admin role has
  it) + the `crm` feature flag (harness org has it). Both verified live.
