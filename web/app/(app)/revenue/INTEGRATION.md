# /revenue ViewSpec integration handoff

Page: `/revenue` — revenue recognition contracts (entity list over
`revenue_contract`) with a `?contract=` flyout (the ContractDrawer drill-down)
and a header Run-recognition action gated on `ar.post`.

Files created (all inside `web/app/(app)/revenue/`, the only dir this page owns):

- `view.ts` — `loadRevenue(sp)` + `revenueSpec(data)`. The loader copies the
  native page's permission, uuid-guard, drawer-resolution and
  drawerReturn-scoping logic verbatim; the drawer payload travels through the
  loader result and the widget renders it.
- `page.tsx` — viewspec branch added FIRST in the component body; native branch
  unchanged.

No `sections.tsx`: the page defines no local display components. The drawer
(`ContractDrawer`) and the run button (`RunRecognitionButton`) are whole
components rendered 1:1 by widgets, not composite cells placed by the spec.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { ContractDrawer } from '../../app/(app)/revenue/ContractDrawer'
import { RunRecognitionButton } from '../../app/(app)/revenue/RunRecognitionButton'

/* --- revenue ------------------------------------------------------------ */
// No `key={remountKey}`: the native page renders <ContractDrawer> without a
// key (same as the journal drawer — its state resets via closeHref
// navigation), so adding one would diverge. This differs from the
// account/party/document drawers deliberately.
'contract-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof ContractDrawer> | null
  if (!drawer) return null
  return <ContractDrawer {...drawer} />
},
// Header action, shown only when the loader's canRun (ar.post) is true —
// presence is enforced by the spec's `when`, not by this renderer.
'run-recognition': () => <RunRecognitionButton />,
```

Exact prop shapes (the coordinator wires them verbatim):

- `contract-drawer`: `{ drawer: ContractDrawerProps | null }` where
  `ContractDrawerProps = Parameters<typeof ContractDrawer>[0]` =
  `{ payload: ContractPayload; canRun: boolean; closeHref?: string }`.
  The spec passes `{ widget: 'contract-drawer', props: { drawer: data.drawer } }`.
  `data.drawer` is `{ payload, canRun, closeHref }` — `closeHref` is always a
  concrete string (`requestedReturn` when it starts with `/revenue`, else
  `'/revenue'`), matching the native `closeHref={...}` default.
- `run-recognition`: `{}` (no props). The spec gates it with `f('canRun')`.
  The native page renders `<RunRecognitionButton />` with no `obligationId`
  (global run, `variant="default"`); the per-obligation buttons inside the
  drawer come along with `<ContractDrawer>` itself.

`'entity-list-view'` already exists and needs no change.

## What the coordinator must NOT create

No new slot is needed. `entity-list-slot.tsx` already re-derives org id, user
id and `canManage` from the session; the revenue page passes no capability
through the spec (no `orgId`, no `userId`, no `emptyAction` — the native page
passes none either, so the list's generic empty state renders on both paths).

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/revenue',
  // Entity list over revenue contracts, plus the contract flyout (portaled
  // to <body>). The simulator never creates revenue contracts, so the list
  // body is seeded by the …29xx fixture block proposed below.
  variants: [
    '',
    // Status filter branch: only the cancelled fixture matches.
    { query: '?status=cancelled', expect: 'table tbody tr', minMatches: 1 },
    // A search that matches nothing renders the generic empty state (the
    // entity list swaps the whole table for EmptyState at total === 0),
    // exactly as the /ar/invoices kind=customer_credit precedent.
    { query: '?q=zzzznomatch', expect: 'main h3', minMatches: 1 },
    // The contract flyout, portaled to <body>.
    {
      query: '?contract=00000000-0000-7000-9000-000000002901',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Verified against the database (`openbooks_sim_viewspec`, harness user
`viewspec@sim.test`, org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, role `admin`):

- `revenue_contracts` for this org: **0** today — the simulator never creates
  them, so the harness would compare two identical empty states. The …29xx
  fixture block below seeds two contracts; with it applied the default variant
  renders 2 rows on page one (default list page size 25) — `minMatches: 2` is
  exact, not conservative.
- Harness user is `admin` (verified via `role_assignments` → `app_roles`),
  so `ar.read` and `ar.post` both hold: the Run button renders on both paths.
- `revenueRecognition` gates the whole segment via `layout.tsx`
  (`requireFeatureEnabled` → `notFound()` when off). The SIM org's
  `settings->'features'` does NOT list it, but its registry default is
  `defaultEnabled: true` and `featureEnabled` falls back to the default when
  no explicit boolean is stored — so the page renders (verified: no explicit
  value stored, default applies).
- Drawer id `…2901` is fixture contract `REV-VS-1`, status `active`, with two
  obligations and schedule lines over the org's real periods `2026-01..03`
  (verified present). The `?status=cancelled` variant matches only fixture
  contract `REV-VS-2` (`…2902`) — 1 row.
- `?q=zzzznomatch` matches the `/ar/invoices ?kind=customer_credit`
  precedent: `EntityListView` renders `<EmptyState>` (an `h3`) instead of the
  table when `total === 0`, so `main h3` with `minMatches: 1` pins the empty
  branch. No fixture needed — any search string absent from both contract
  numbers works.
- `minMatches` for the drawer variant follows the journal/ar precedent
  (`[data-drawer-layer]`, 1).

## Fixture proposal (coordinator: append to `scripts/viewspec-fixtures.sql`)

Block `…2901-2919` is claimed for revenue. Verified free: zero ids with last
block `00000029xx` exist anywhere in the file (the allocation table's listed
`…2801-2899` field-ticket block and every other used prefix were grepped;
`…29xx` appears nowhere). The block also needs one journal entry number:
`REV-VS-1` is unused in the SIM org (verified: 0 rows; `entry_number` is
unique per org via `journal_entries_org_number`).

```sql
  -- ---- revenue contracts ---------------------------------------------------
  --
  -- The simulator never creates revenue contracts, so /revenue is empty
  -- without these: two contracts, one active with obligations + schedules
  -- (the drawer path) and one cancelled (the ?status=cancelled branch).
  -- FK targets resolve from the tenant at seed time so the block survives a
  -- rebuild; only the seeded rows carry fixed ids (…2901-2919 claimed; grep
  -- the file — no other block holds …29xx).
  declare
    v_customer uuid;
    v_rule uuid;
    v_deferred uuid;
    v_recognized uuid;
    v_book uuid;
    v_per1 uuid;
    v_per2 uuid;
    v_per3 uuid;
    v_sub uuid;
    v_user uuid;
    v_je uuid := '00000000-0000-7000-9000-000000002911';
  begin
    select id into v_customer from parties
     where org_id = v_org and is_active order by display_name limit 1;
    -- Rule-level default accounts: any active non-summary balance-sheet and
    -- income accounts; obligation overrides stay null.
    select id into v_deferred from accounts
     where org_id = v_org and is_active and not is_summary
       and type in ('liability_current_other', 'liability_long_term')
     order by number nulls last limit 1;
    select id into v_recognized from accounts
     where org_id = v_org and is_active and not is_summary
       and type in ('income', 'income_other')
     order by number nulls last limit 1;
    select id into v_book from accounting_books
     where org_id = v_org and is_primary limit 1;
    select id into v_per1 from accounting_periods
     where org_id = v_org and name = '2026-01' limit 1;
    select id into v_per2 from accounting_periods
     where org_id = v_org and name = '2026-02' limit 1;
    select id into v_per3 from accounting_periods
     where org_id = v_org and name = '2026-03' limit 1;
    select id into v_sub from subsidiaries
     where org_id = v_org order by name limit 1;
    select id into v_user from users
     where org_id = v_org and email = 'viewspec@sim.test';
    if v_customer is null or v_deferred is null or v_recognized is null
       or v_book is null or v_per1 is null or v_per2 is null or v_per3 is null
       or v_sub is null or v_user is null then
      raise notice 'missing revenue fixture prerequisites; skipping';
      return;
    end if;

    insert into recognition_rules
      (id, org_id, code, name, method, recognition_periods,
       deferred_account_id, recognized_account_id, is_active)
    values ('00000000-0000-7000-9000-000000002900', v_org, 'VS-SL-3MO',
            'ViewSpec straight-line 3mo', 'straight_line_even', 3,
            v_deferred, v_recognized, true)
    on conflict (id) do nothing;
    select id into v_rule from recognition_rules
     where org_id = v_org and code = 'VS-SL-3MO';

    insert into revenue_contracts
      (id, org_id, customer_id, contract_number, status,
       starts_on, ends_on, total_transaction_price, currency, pricing)
    values
      ('00000000-0000-7000-9000-000000002901', v_org, v_customer, 'REV-VS-1', 'active',
       '2026-01-01', '2026-03-31', 9000.0000, 'USD', '{}'::jsonb),
      ('00000000-0000-7000-9000-000000002902', v_org, v_customer, 'REV-VS-2', 'cancelled',
       '2026-01-01', '2026-01-31', 1000.0000, 'USD', '{}'::jsonb)
    on conflict (id) do nothing;

    insert into performance_obligations
      (id, org_id, contract_id, description, recognition_rule_id,
       allocated_price, recognition_starts_on, recognition_ends_on, status)
    values
      ('00000000-0000-7000-9000-000000002903', v_org,
       '00000000-0000-7000-9000-000000002901',
       'ViewSpec implementation', v_rule,
       6000.0000, '2026-01-01', '2026-03-31', 'open'),
      ('00000000-0000-7000-9000-000000002904', v_org,
       '00000000-0000-7000-9000-000000002901',
       'ViewSpec support', v_rule,
       3000.0000, '2026-01-01', '2026-03-31', 'open')
    on conflict (id) do nothing;

    insert into recognition_schedules
      (id, org_id, obligation_id, book_id, status, total_amount)
    values
      ('00000000-0000-7000-9000-000000002905', v_org,
       '00000000-0000-7000-9000-000000002903', v_book, 'in_progress', 6000.0000),
      ('00000000-0000-7000-9000-000000002906', v_org,
       '00000000-0000-7000-9000-000000002904', v_book, 'planned', 3000.0000)
    on conflict (id) do nothing;

    -- The drawer's recognized-vs-planned split needs one POSTED line: a
    -- posted entry is immutable (jl_guard), so the balance legs go in as
    -- draft first and the entry is posted afterwards — the banking block's
    -- pattern (guarded by existence, not ON CONFLICT: the guard fires even
    -- when every row would be a no-op, so a second run would fail).
    if not exists (select 1 from journal_entries where id = v_je) then
      insert into journal_entries
        (id, org_id, book_id, entry_number, posting_date, period_id, status, subsidiary_id)
      values (v_je, v_org, v_book, 'REV-VS-1', '2026-01-31', v_per1, 'draft', v_sub);
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id)
      values ('00000000-0000-7000-9000-000000002912', v_org, v_je, 1,
              v_recognized, 2000.0000, 'USD', 2000.0000, v_sub),
             ('00000000-0000-7000-9000-000000002913', v_org, v_je, 2,
              v_deferred, -2000.0000, 'USD', -2000.0000, v_sub);
      update journal_entries set status = 'posted', posted_at = now(), posted_by = v_user
       where id = v_je and status <> 'posted';
    end if;

    insert into recognition_schedule_lines
      (id, org_id, schedule_id, period_id, sequence,
       planned_amount, recognized_amount, journal_entry_id)
    values
      -- Obligation 1: Jan posted (recognized), Feb + Mar still planned.
      ('00000000-0000-7000-9000-000000002907', v_org,
       '00000000-0000-7000-9000-000000002905', v_per1, 1,
       2000.0000, 2000.0000, v_je),
      ('00000000-0000-7000-9000-000000002908', v_org,
       '00000000-0000-7000-9000-000000002905', v_per2, 2,
       2000.0000, null, null),
      ('00000000-0000-7000-9000-000000002909', v_org,
       '00000000-0000-7000-9000-000000002905', v_per3, 3,
       2000.0000, null, null),
      -- Obligation 2: nothing posted — the drawer's all-planned branch.
      ('00000000-0000-7000-9000-00000000290a', v_org,
       '00000000-0000-7000-9000-000000002906', v_per1, 1,
       1000.0000, null, null),
      ('00000000-0000-7000-9000-00000000290b', v_org,
       '00000000-0000-7000-9000-000000002906', v_per2, 2,
       1000.0000, null, null),
      ('00000000-0000-7000-9000-00000000290c', v_org,
       '00000000-0000-7000-9000-000000002906', v_per3, 3,
       1000.0000, null, null)
    on conflict (id) do nothing;
  end;
```

Fixture claim verification (all against `openbooks_sim_viewspec`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`):

- `revenue_contracts` for the SIM org: 0 (simulator never creates them).
- Periods `2026-01/02/03` exist with ids `02b3912b…/3f15c4e5…/79e6dc5c…`.
- Primary book: `b6f2482d…` (`Primary`); exactly 1 subsidiary; active parties
  exist (e.g. `Cascade Building Supply`); income accounts `4000/4010/4020…`
  and `liability_current_other` accounts `2100/2110` exist; harness user
  `viewspec@sim.test` exists in this org with role `admin`.
- `recognition_rules` table-wide: 0, so rule code `VS-SL-3MO` is fresh (and
  scoped by the `(org_id, code)` unique index regardless).
- `entry_number 'REV-VS-1'`: 0 rows in this org (unique per org).
- **NOT yet executed**: this proposal was verified by read-only SELECTs only.
  The coordinator owns `viewspec-fixtures.sql`; row counts above assume the
  block applied. The fixture SQL itself was NOT run here (it edits a shared
  file) and NOT dry-run in a transaction — flagging this so the coordinator
  can validate `…290a/…290b/…290c` (hex letters in the last nibble are legal
  uuid) on apply.

## Could not express

Nothing structural. Two coverage notes:

- The drawer edit-mode branch does not exist on this page — the
  ContractDrawer is read-only on both paths (recognition posts through the
  Run buttons), so there is no mode branch to pin.
- The `canRun === false` branch (no Run button, no per-obligation buttons)
  has no harness user to exercise it: `viewspec@sim.test` is `admin`. Both
  widgets are verbatim renders of the native components with the same props,
  not re-expressions, so the branch is a presence flag either way.
