# /subcontracts ViewSpec integration handoff

Page: `web/app/(app)/subcontracts/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the only component is the existing
`SubcontractsWorkspace`, reused whole (same shape as the
`/admin/setup/labor-costing` and `/property-management` conversions).

Spec shape: `list` layout (the native page renders `ListPageLayout` with a
`PageHeader` + the workspace as its body), one `page-header` block with NO
actions (the native header has no actions — "New subcontract" lives inside
the workspace card), and one `subcontracts-workspace` widget block. The
loader does every server decision the native page made; only plain data
crosses the spec.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (verified by grep: no `ubcontract` hits in the registry
file today):

```tsx
import { SubcontractsWorkspace } from '../../app/(app)/subcontracts/SubcontractsWorkspace'
```

Entry:

```tsx
/**
 * The whole SubcontractsWorkspace client island: the register card (header
 * with New-subcontract button, loading / empty / table states), the create
 * drawer, and the 2xl detail drawer with its six tabs (overview / sov /
 * changes / applications / retainage / controls), lifecycle actions, pay-app
 * editor, and release-control sub-drawer. Every tab switch, selection,
 * fetch (GET/POST /api/subcontracts) and mutation owns `useState`, so the
 * workspace arrives whole — decomposing its register table into spec blocks
 * would render the pre-fetch set and strand the tab state from what it
 * shows (the /reports lesson, also documented on the labor-costing and
 * property-management pages). The LOADER makes every data decision (gates,
 * pickers, permission flags, multiCurrency probe); the widget only renders.
 * No remount key: the native page renders the workspace keyless.
 *
 * EXACT prop shape: SIX FLAT props — `projects`, `vendors`,
 * `expenseAccounts`, `parties`, `multiCurrency`, `permissions` — passed
 * directly, exactly as the native page passes them. Each picker row is
 * `{ id, name, currency? }`; `permissions` is
 * `{ create, approve, post, pay }`; `multiCurrency` is a boolean (native
 * default `false` preserved). There is no nested `workspace` bag; do not
 * wrap them in one.
 */
'subcontracts-workspace': (props) => (
  <SubcontractsWorkspace
    {...(props as unknown as ComponentProps<typeof SubcontractsWorkspace>)}
  />
),
```

`ComponentProps` is already imported in the registry file. All six props
are plain JSON-serializable data. No Authz, org id, user id, or bound
action crosses the spec.

## 2. Slot proposals (none)

No slot is needed. Authz, org id, user id and feature state are consumed
server-side by the loader; only plain data (four option lists, four
permission booleans, one feature boolean) crosses the spec. The workspace
persists mutations through the session cookie inside the shared component.
(Same division as labor-costing §2 and property-management §2.)

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/subcontracts',
  // Whole-workspace page: the loader resolves the header, four pickers,
  // permission flags and the multiCurrency probe; the client island fetches
  // /api/subcontracts and renders the register card, drawers and tabs.
  // One fixture subcontract (active, one SOV line, so the register table
  // has a row on both paths).
  //
  // ONE variant only. The tab strip, selection and all drawers are client
  // state with no URL affordance, and the page takes no search params — a
  // second variant would render byte-identical markup, which
  // assertVariantsDiffer rejects (the /query precedent).
  variants: [''],
  expect: 'table tbody tr',
  minMatches: 1,
},
```

GATES verification (read-only queries against `openbooks_sim_viewspec`,
SIM org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a` — "SIM · Summit Ridge
Construction"):

- Permission gate: `requirePermission('ap.read')`. Harness user
  `viewspec@sim.test` holds the `Administrator` role whose `permissions`
  array contains `"ap.read"` (verified). Derived flags for this user, all
  verified present in the same array: `create` (`ap.create`), `approve`
  (`ap.approve`), `post` (`ap.post`), `pay` (`ap.pay`) — all true.
- Feature gate (TWO layers, both must pass): the segment `layout.tsx`
  runs `requireFeatureEnabled(orgId, 'subcontracts')` → `notFound()`,
  and `page.tsx` runs `requireSubcontractsFeature` → redirect to
  `/admin/setup/features`. `subcontracts` is `defaultEnabled: false`
  (`engine/src/feature-registry.ts:77`) and the harness org's
  `settings->'features'` blob has no `subcontracts` key (verified — it
  holds `projects: true` among 16 keys, but not `subcontracts`), so
  **both branches 404/redirect identically in the harness tenant
  today**. Do NOT register this entry until §4 is applied: the
  `'subcontracts': true` merge makes both gates pass on both paths, and
  only then does the comparison mean anything (the /query lesson —
  comparing two error pages is a false pass).
- Supporting probes are deterministic in the harness tenant either way:
  `multiCurrency` off (no foreign-currency `documents` rows — only `USD`
  — so the vendors query selects without `vr.currency`), 14 active
  non-closed/cancelled projects, 12 active vendors with active
  `vendor_roles`, 21 active non-summary expense/COGS accounts, 29 active
  parties (under the 2000 cap).
- Subsidiary scope: harness role's `subsidiary_restriction` is
  `{"mode": "all"}` → `allowedSubsidiaryIds` resolves null. The loader's
  four queries carry no subsidiary filter, and the fixture's project has
  `subsidiary_id` null (verified), so the fixture row renders for the
  harness user under the API's `subsidiaryVisibleFilter` as well.
- No logged-out variant is proposed (the harness is always
  authenticated; the login redirect is framework behavior, not page
  content — the labor-costing precedent).

Row-count verification: `subcontracts` holds **0 rows** in the sim org
today, so `minMatches: 1` counts the single §4 fixture subcontract.

## 4. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims fresh block **…0801-0899** (verified unused — zero `…08xx` ids
exist in the file today; `grep -c` for `000000000801|000000000802|
000000000899` returns 0 and no `00000000-0000-7000-9000-0000000008xx`
id matches). Please also add `…0801-0899  subcontracts` to the
allocation table at the top of the file.

What §4 must do (coordinator's edit, not mine — `viewspec-fixtures.sql`
is coordinator-owned):

1. Merge `'subcontracts': true` into the org-features `jsonb_build_object`
   in the "feature switches" section (same pattern as the existing
   `'propertyManagement', true` entry), so the layout gate and the page
   gate both pass in the harness tenant.
2. Insert ONE subcontract + ONE SOV line, fixed ids, `ON CONFLICT DO
   NOTHING`:
   - subcontract `00000000-0000-7000-9000-000000000801`: `org_id = v_org`,
     `project_id` = the "Bridge Inspection Repairs (NTE)" project
     (look up by name within `v_org`; it is active, non-closed, and its
     `subsidiary_id` is null — verified), `vendor_id` = "Apex Mechanical
     Subs" (look up by `display_name`; it has an active `vendor_role` —
     verified), `number = 'VSPEC-001'`, `title = 'ViewSpec conformance
     subcontract'`, `status = 'active'`, `currency = 'USD'`,
     `original_commitment = 100000`, `default_retainage_percent = 10`.
     (`number` has a unique `(org_id, number)` index — `VSPEC-001`
     collides with nothing; no `VSPEC` numbers exist in the sim org.
     NOT NULL columns all covered: `project_id`, `vendor_id`,
     `number`, `title`, `status`, `currency`, `original_commitment`,
     `default_retainage_percent`.)
   - SOV line `00000000-0000-7000-9000-000000000802` on that subcontract
     (`scheduled_value = 100000`, description 'Conformance SOV line';
     match the `subcontract_sov_lines` NOT NULL columns at write time).
   - `active` sorts first in the register's `ORDER BY CASE`, so the row
     is found by `table tbody tr` regardless of other data.
3. Why one row is enough: the register table, SOV tables, and all six
   drawer tabs are client state fed by `/api/subcontracts`; a single
   `active` subcontract with a billed-to-date of 0 exercises the table
   path (`Number`, `Subcontract`, `Project`, `Vendor`, `Status`,
   `Revised`, `Billed` columns) on both renders. The empty state
   (`No subcontracts yet`) is the zero-row branch the harness explicitly
   refuses to compare alone — the fixture is what makes the comparison
   mean anything.

## 5. What could not be expressed (nothing structural)

- Nothing on this page needed new ViewSpec vocabulary. The register card,
  the create drawer, the six-tab detail drawer, the conditional action
  buttons (`Submit`/`Approve`/`Void`/…), the pay-application editor, and
  the release-control sub-drawer are all client-state composites that
  stay inside the shared `SubcontractsWorkspace` component by design.
- `sections.tsx` was not needed: every local component (`StatusBadge`,
  `Metric`, `Overview`, `SovSection`, `ChangesSection`,
  `ApplicationsSection`, `PayApplicationEditor`, `RetainageSection`,
  `ControlsSection`, `Field`, `CreateSubcontractDrawer`) lives in
  `SubcontractsWorkspace.tsx`, which both render paths share — no copy
  was made.
