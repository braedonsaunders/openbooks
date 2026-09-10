# /budgets ViewSpec integration handoff

Page: `/budgets` — budget scenarios (entity list) with the budget workspace
flyout (`?budget=` over `budget_scenarios` ids, plus the prefixed
`budgetQ`/`budgetPage`/dimension worksheet params).

Files created (all inside `web/app/(app)/budgets/`, the only dir this page owns):

- `view.ts` — `loadBudgets(sp)` + `budgetsSpec(data)`. The loader copies the
  native page's query, permission and formatting logic verbatim (budgets.read
  gate, budgets feature gate, `budgets.manage` New-button visibility,
  `parsePrefixedListParams(sp, 'budget', …)` worksheet params, uuid-validated
  dimension filters, books/years pickers, sources query, close-href fallback).
  The drawer payload, the remount key, and the New-button visibility are data.
- `page.tsx` — viewspec branch added FIRST in the component body; native branch
  unchanged.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { NewBudgetButton } from '../../app/(app)/budgets/NewBudgetButton'
import { BudgetDrawer } from '../../app/(app)/budgets/BudgetDrawer'

/* --- budgets ------------------------------------------------------------ */
'new-budget': (props) => (
  <NewBudgetButton
    currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
  />
),
'budget-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof BudgetDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <BudgetDrawer key={remountKey} {...rest} />
},
```

Byte-equivalence notes (checked against `budgets/page.tsx`):

- `NewBudgetButton` needs only `currentParams`. It checks no permission
  client-side — the `/api/budgets/draft` endpoint enforces it, exactly as on
  the native path. The spec places this widget twice (header actions gated on
  `canManage`, empty-state action) — the same `<NewBudgetButton
  currentParams={sp} />` element the native page passes as both `actions` and
  `emptyAction`. Both placements instantiate the component twice in the native
  render too, so hook state is per-placement in both paths.
- The native page renders the header actions prop ONLY for a manager
  (`actions={canManage ? … : undefined}`, so no actions wrapper renders at
  all otherwise); the conditional widget (`when: canManage`) is the spec's
  equivalent. Same arrangement for `emptyAction`.
- The remount key rides as a prop
  (`key={scenario.id-revision-dept-proj-loc-class}` natively), the same
  arrangement as `account-drawer`/`project-drawer`. Switching scenarios,
  revisions, or dimensional slices must reset the drawer's client state, and
  a widget at a fixed position would otherwise be reused.
- `initialMode` is not a prop here — `BudgetDrawer` derives nothing from
  `?mode`; editability is `canManage && scenario.status === 'draft'`,
  computed inside the component from props the loader already passes.
- The drawer's `viewMode` (`budgetView === 'monthly'`) is read from
  `currentParams` inside the component, so it needs no loader prop.

## What the coordinator must NOT create

No new slot is needed. `entity-list-view` already exists and needs no change:
the `budget_scenario` source (`web/lib/list/entity-sources.ts:490`,
`drawerParam: 'budget'`, `basePath: '/budgets'`) is registered, and
`entity-list-slot.tsx` already re-derives org id, user id and `canManage`
from the session. The drawer's own `?budgetQ`/`?budgetPage`/dimension params
ride inside `sp`, so the workspace worksheet keeps working on both paths.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/budgets',
  // Entity list over budget scenarios plus the workspace flyout over one
  // scenario id. The budgets feature defaults on (feature-registry.ts) and
  // the harness admin holds budgets.* via the admin role.
  variants: [
    '',
    // Deliberate empty result: asserts the generic empty state plus the New
    // button as emptyAction, not row content.
    '?q=zzzznomatch',
    // The flyout is portaled to <body>: without naming that root the
    // comparison never looks at the drawer at all.
    {
      query: '?budget=00000000-0000-7000-9000-000000000801',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

Verified against the database (`openbooks_sim_viewspec`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`); fixtures below are NOT yet applied,
so these counts hold once they land:

- `budget_scenarios` in the SIM org today: **0** (verified: `select
  count(*)` returns 0; non-archived likewise 0). The harness would reject
  this page without fixtures.
- Fixture seeds **3** scenarios (draft budget, pending-approval budget,
  approved forecast — spanning the status chips) ⇒ default variant renders
  3 rows ⇒ `minMatches: 3` verified once fixtures land.
- Drawer id `…0801` is a draft on fiscal year **2026** with the SIM org's
  Primary book; 2026 has **3** periods in the SIM org and the org has
  **66** active non-summary accounts (of which ~25 are budget-eligible
  expense/cogs/income types), so the workspace query resolves non-empty.
- Two `budget_lines` rows on `…0801` (period 2026-01, two real SIM-org
  expense accounts) exercise the drawer's line grid on the drawer variant.
- The `?q=zzzznomatch` empty variant needs no fixture (matches nothing by
  construction).

## Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed ids in the claimed `…0801–0899` block (free — no `08xx`
id appears in the fixture file and none exists in the sim DB), `ON CONFLICT
DO NOTHING`, SIM org only (same `v_org` pattern as the existing blocks).
Update the block-allocation comment at the top of the file:
`…0801-0899  budgets`.

```sql
  -- ---- budgets -------------------------------------------------------------
  -- The simulator never writes budget scenarios, so the list page would
  -- compare two identical empty states. Three scenarios (one draft with
  -- lines, for the drawer variant) in the SIM org, on fiscal year 2026
  -- which has periods in the SIM org.
  insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status, description, revision)
  values
    ('00000000-0000-7000-9000-000000000801', v_org,
     (select id from accounting_books where org_id = v_org and is_active order by is_primary desc, name limit 1),
     2026, 'ViewSpec FY26 operating budget', 'budget', 'draft', 'ViewSpec harness budget one', 1),
    ('00000000-0000-7000-9000-000000000802', v_org,
     (select id from accounting_books where org_id = v_org and is_active order by is_primary desc, name limit 1),
     2026, 'ViewSpec FY26 stretch budget', 'budget', 'pending_approval', 'ViewSpec harness budget two', 1),
    ('00000000-0000-7000-9000-000000000803', v_org,
     (select id from accounting_books where org_id = v_org and is_active order by is_primary desc, name limit 1),
     2026, 'ViewSpec FY26 forecast', 'forecast', 'approved', 'ViewSpec harness forecast', 1)
  on conflict (id) do nothing;

  insert into budget_lines (org_id, scenario_id, account_id, period_id, amount)
  values
    (v_org, '00000000-0000-7000-9000-000000000801',
     (select id from accounts where org_id = v_org and is_active and not is_summary and type = 'expense' order by number limit 1),
     (select id from accounting_periods where org_id = v_org and fiscal_year = 2026 and not is_adjustment order by period_number limit 1),
     12000),
    (v_org, '00000000-0000-7000-9000-000000000801',
     (select id from accounts where org_id = v_org and is_active and not is_summary and type = 'expense' order by number limit 1 offset 1),
     (select id from accounting_periods where org_id = v_org and fiscal_year = 2026 and not is_adjustment order by period_number limit 1),
     8000)
  on conflict do nothing;
```

Notes:

- `budget_lines.amount` is NOT NULL with no default; `note` is nullable
  (omitted). `note` omitted ⇒ NULL.
  `budget_lines.id` defaults to `uuid_generate_v7()` (omitted).
- `budget_scenarios.created_by`/`updated_by` are nullable (omitted).
- `created_at`/`updated_at` default to now; the sources query orders by
  `updated_at desc`, so all three fixtures are equally recent — fine for
  the drawer variant, which opens `…0801` by id.
- `revision` is NOT NULL with default 1; set explicitly for clarity.
- Statuses span `draft` + `pending_approval` + `approved` and kinds span
  `budget` + `forecast`, so the status/kind filter chips render with real
  counts on the default variant.
- The `?budget=<id>` drawer variant needs only the scenario row plus live
  org data (periods, accounts, books); the two line rows exercise the
  drawer's line grid on the same variant.
- `budget_lines` conflict target: `on conflict do nothing` without a target
  is valid Postgres and matches the file's idempotent contract — adjust to
  the table's actual unique constraint if the harness lint requires an
  explicit target.

## Could not express

Nothing structural. No `sections.tsx`: the page owns no composite cells —
the header is a plain `pageHeader`, the list is the universal entity list,
and the drawer is the `BudgetDrawer` client island (a 700-line interactive
worksheet: cell editing, save chains, import/export, approval actions) that
travels through the loader as an opaque payload, the same arrangement as
`account-drawer`/`asset-drawer`. No `packages/viewspec` changes proposed.
The three coordinator cautions do not trigger here: no native `<section>`
(the list owns its markup), no widget-cell `tabular-nums` `<td>` in
page-owned markup, no page-owned pager.
