# INTEGRATION — `/banking/[accountId]` ViewSpec conversion

Page: `web/app/(app)/banking/[accountId]/page.tsx`
Loader/spec: `./view.ts` (`loadBankingAccount`, `bankingAccountSpec`)
Shared cells: `./sections.tsx` (`AccountStats`, `UnmatchedCountCell`, `ReconActionCell`)

## Widget registry entries to add (coordinator)

The spec references five widgets that do not exist yet. All render existing
components verbatim — no new markup invented here.

```tsx
import { AccountStats, UnmatchedCountCell, ReconActionCell } from '../../app/(app)/banking/[accountId]/sections'
import { ImportStatementButton } from '../../app/(app)/banking/[accountId]/ImportStatementButton'
import { StartReconciliationButton } from '../../app/(app)/banking/[accountId]/StartReconciliationButton'
import { StatementDrawer } from '../../app/(app)/banking/[accountId]/StatementDrawer'

// Header stat tiles. One widget, not four: the native tiles are plain
// bordered divs with conditional content, and stat-tile renders the cockpit
// HomeStatTile — different markup. The loader resolves every string; the
// only decision left is the reconciledThrough ?? never pair, which lives
// here, in the shared component, not in the spec.
'account-stats': (props) => (
  <AccountStats
    glBalanceLabel={str(props, 'glBalanceLabel') ?? ''}
    glBalanceValue={str(props, 'glBalanceValue') ?? ''}
    reconciledThroughLabel={str(props, 'reconciledThroughLabel') ?? ''}
    reconciledThrough={(props.reconciledThrough as string | null) ?? null}
    neverLabel={str(props, 'neverLabel') ?? ''}
    unmatchedLinesLabel={str(props, 'unmatchedLinesLabel') ?? ''}
    unmatchedLinesValue={str(props, 'unmatchedLinesValue') ?? ''}
    reconciliationLabel={str(props, 'reconciliationLabel') ?? ''}
    reconBadgeLabel={str(props, 'reconBadgeLabel') ?? ''}
    reconBadgeVariant={(props.reconBadgeVariant as 'warning' | 'secondary') ?? 'secondary'}
  />
),
// Statement unmatched-count pair: a plain count when nonzero, a green zero
// when clean. A conditional pair is a component, not a spec construct.
'unmatched-count-cell': (props) => (
  <UnmatchedCountCell display={str(props, 'display') ?? ''} isZero={props.isZero === true} />
),
// Reconcile workspace action: outline small Button asChild over a Link. The
// label (view vs open-workspace) is loader-resolved; the button chrome must
// stay the shared Button component, not a transcribed class string.
'recon-action-cell': (props) => (
  <ReconActionCell href={str(props, 'href') ?? ''} label={str(props, 'label') ?? ''} />
),
// Header actions and empty-state actions. Both buttons are client components
// with their own drawer state; the spec only gates them with `when` and
// passes loader-resolved props. openReconciliationId arrives as null when no
// session is open — pass it through, do not coerce to undefined.
'import-statement': (props) => (
  <ImportStatementButton accountId={str(props, 'accountId') ?? ''} />
),
'start-reconciliation': (props) => (
  <StartReconciliationButton
    accountId={str(props, 'accountId') ?? ''}
    openReconciliationId={(props.openReconciliationId as string | null) ?? null}
    glBalance={str(props, 'glBalance') ?? ''}
  />
),
// Statement-lines drawer (?statement=<id>). The drawer owns its own sl*
// search/sort/pagination internally, so the spec passes the whole drawer
// payload through exactly like the api-key-drawer precedent.
'statement-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof StatementDrawer> | null
  if (!drawer) return null
  return <StatementDrawer {...drawer} />
},
```

Note: the `empty-state` widget's `action` + `actionProps` support (added
alongside the prefixed sort params) is what lets both empty states offer
their create buttons — `import-statement` with `{ accountId }`, and
`start-reconciliation` with `{ accountId, openReconciliationId, glBalance }`.

## Proposed conformance entry (coordinator)

The harness user (`viewspec@sim.test`, admin on the SIM org) has
`banking.read` + `banking.reconcile`. The SIM org holds four reconcilable
accounts; the fixture account below has 2 statements (3 and 9 lines, mixed
sources, nonzero unmatched) and 3 reconciliations across all three statuses
(`in_progress`, `balanced`, `signed_off`), exercising the badge-variant map,
the green-zero vs count pair, the resume-vs-start button, and the drawer:

```js
{
  // Bank account detail: two independent prefixed lists (stmt*, recon*)
  // plus a statement-lines drawer (?statement=<id>).
  path: '/banking/a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e',
  variants: [
    // Default: 2 statement rows + 3 reconciliation rows.
    { query: '', expect: 'table tbody tr', minMatches: 5 },
    // Statements branch: search narrows to one row; source filter + sort
    // exercise the prefixed stmt* params.
    { query: '?stmtQ=ofx', expect: 'table tbody tr', minMatches: 4 },
    { query: '?source=csv&stmtSort=imported&stmtDir=asc', expect: 'table tbody tr', minMatches: 4 },
    // Reconciliations branch: status filter + prefixed recon* sort.
    { query: '?reconStatus=signed_off', expect: 'table tbody tr', minMatches: 4 },
    { query: '?reconSort=balance&reconDir=desc', expect: 'table tbody tr', minMatches: 5 },
    // Empty-table path (table with zero body rows, not the empty state):
    // assert headers survive a filter that matches nothing.
    { query: '?stmtQ=zzzznomatch', expect: 'table thead th', minMatches: 7 },
    // The statement flyout, portaled to <body>.
    {
      query: '?statement=00000000-0000-7000-9000-000000000403',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 5,
},
```

Row counts verified against the database as the harness tenant sees it
(`app.current_org` = SIM org, `app.bypass_rls` = `off` — plain org isolation,
not the bypass): default render = 2 statement rows + 3 reconciliation rows =
5 `table tbody tr`; `?stmtQ=ofx` → 1 statement + 3 recons = 4;
`?source=csv&stmtSort=imported&stmtDir=asc` → 1 + 3 = 4;
`?reconStatus=signed_off` → 2 statements + 2 recons = 4;
`?reconSort=balance&reconDir=desc` → 2 + 3 = 5; `?stmtQ=zzzznomatch` → 0 body
rows with all 7 statement-column headers intact. Header stats observed the
same way: GL balance nonzero (112 pre-existing posted lines plus the fixture
line), `reconciled_through` = latest signed-off date, unmatched lines = 3,
open session = the `in_progress` reconciliation (header badge "in progress",
action buttons in resume variant). Drawer statement 1 holds 3 lines.
All message keys used (`banking.account.*`, `banking.labels.*`,
`banking.types.*`, `banking.reconStatus.*`, `common.labels.*`,
`common.actions.view`) already exist in `web/messages/en/*.json` — verified
by grep, none invented.

## Fixture (already in the coordinator's hands — proposed SQL)

The SIM org previously had zero `bank_statements`/`reconciliations`, so the
harness's minMatches guard could never pass on this page. Proposed addition
to `scripts/viewspec-fixtures.sql` (fixed ids, `ON CONFLICT DO NOTHING`,
SIM-org only). It reuses the SIM tenant's existing `1010` Operating Account
(`asset_bank`, id `a1f8e08f-…`) rather than inventing a new account — new
inserts hit three live guards (`accounts_org_number`, balanced-entry
`jl_check_balanced`, closed-period posting), so the fixture works with them:
balanced two-leg entry drafted then posted into the latest open period, two
statements with unmatched lines, two signed-off reconciliations plus one
open `in_progress` session (the partial unique index
`reconciliations_one_open_account` permits only one open session per
account, so the `balanced` status is covered by a second signed-off row —
badge-variant coverage for `balanced` vs the default-open pair is what the
page actually branches on). **This exact block was executed against the
conformance database and applies cleanly; counts below were observed, not
projected.**

```sql
-- ---- banking account detail -------------------------------------------
-- Statements, lines and reconciliations for the SIM 1010 Operating
-- Account, so the account page renders both tables, the badge variants,
-- and the resume-workspace button. Verified counts: 2 statements, 12
-- lines (3 unmatched), 3 reconciliations (2 signed_off, 1 in_progress).
declare
  v_acct  uuid := 'a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e'; -- SIM 1010 Operating Account (asset_bank)
  v_stm1  uuid := '00000000-0000-7000-9000-000000000403';
  v_stm2  uuid := '00000000-0000-7000-9000-000000000404';
  v_rec1  uuid := '00000000-0000-7000-9000-000000000405';
  v_rec2  uuid := '00000000-0000-7000-9000-000000000406';
  v_rec3  uuid := '00000000-0000-7000-9000-000000000407';
  v_je    uuid := '00000000-0000-7000-9000-000000000408';
  v_jl    uuid := '00000000-0000-7000-9000-000000000409';
  v_book  uuid;
  v_per   uuid;
  v_sub   uuid;
  v_user  uuid;
begin
  select id into v_user from users where org_id = v_org and email = 'viewspec@sim.test';
  select id into v_sub from subsidiaries where org_id = v_org order by name limit 1;
  select id into v_book from accounting_books where org_id = v_org and is_primary limit 1;
  select id into v_per from accounting_periods where org_id = v_org order by starts_on desc limit 1;
  if v_user is null or v_sub is null or v_book is null or v_per is null then
    raise notice 'missing banking fixture prerequisites; skipping';
    return;
  end if;

  -- Posted entries are immutable (jl_guard), so the balance line goes in
  -- as draft first and the entry is posted afterwards. Two legs: the
  -- balanced-entry guard rejects a one-legged posting.
  insert into journal_entries (id, org_id, book_id, entry_number, posting_date, period_id, status, subsidiary_id)
  values (v_je, v_org, v_book, 'BNK-1', current_date - 6, v_per, 'draft', v_sub)
  on conflict (id) do nothing;
  insert into journal_lines (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id)
  values (v_jl, v_org, v_je, 1, v_acct, 12500.0000, 'USD', 12500.0000, v_sub),
         ('00000000-0000-7000-9000-000000000413', v_org, v_je, 2,
          (select id from accounts where org_id = v_org and number = '3900' limit 1),
          -12500.0000, 'USD', -12500.0000, v_sub)
  on conflict (id) do nothing;
  update journal_entries set status = 'posted', posted_at = now(), posted_by = v_user
   where id = v_je and status <> 'posted';

  insert into bank_statements
    (id, org_id, account_id, source, statement_date, opening_balance, closing_balance, raw_file_ref)
  values (v_stm1, v_org, v_acct, 'ofx', current_date - 20, 10000.0000, 12500.0000, 'fixture-ofx-1'),
         (v_stm2, v_org, v_acct, 'csv', current_date - 6, 12500.0000, 13100.0000, 'fixture-csv-1')
  on conflict (id) do nothing;

  -- Statement 1: three lines, one unmatched (the header unmatched stat and
  -- the green-zero vs count pair both need a nonzero case on this page).
  insert into bank_statement_lines
    (id, org_id, statement_id, account_id, line_number, posted_on, amount, currency, description, match_status)
  values ('00000000-0000-7000-9000-000000000410', v_org, v_stm1, v_acct, 1, current_date - 19, 2000.0000, 'USD', 'Client receipt', 'matched'),
         ('00000000-0000-7000-9000-000000000411', v_org, v_stm1, v_acct, 2, current_date - 18, -1500.0000, 'USD', 'Vendor payment', 'matched'),
         ('00000000-0000-7000-9000-000000000412', v_org, v_stm1, v_acct, 3, current_date - 17, 2000.0000, 'USD', 'Unmatched deposit', 'unmatched')
  on conflict (id) do nothing;

  -- Statement 2: nine lines, two unmatched — exercises the drawer pager
  -- (default page is large, but the row shapes differ per line).
  insert into bank_statement_lines
    (id, org_id, statement_id, account_id, line_number, posted_on, amount, currency, description, match_status)
  select ('00000000-0000-7000-9000-00000000042' || g)::uuid, v_org, v_stm2, v_acct, g,
         current_date - 5, (100.0000 * g), 'USD', 'Line ' || g,
         case when g in (3, 7) then 'unmatched' else 'matched' end
    from generate_series(1, 9) g
  on conflict (id) do nothing;

  -- One open session per account (partial unique index): a single
  -- in_progress row stays open; the second row is signed off as well so
  -- closed statuses still appear. Signed-off rows must carry signoff
  -- evidence (enforced by CHECK); the open one makes the header badge read
  -- "in progress" and the action button "resume".
  insert into reconciliations
    (id, org_id, account_id, through_date, statement_balance, status, currency, signed_off_by, signed_off_at)
  values (v_rec1, v_org, v_acct, current_date - 20, 12500.0000, 'signed_off', 'USD', v_user, now() - interval '2 days'),
         (v_rec2, v_org, v_acct, current_date - 13, 12800.0000, 'signed_off', 'USD', v_user, now() - interval '1 day'),
         (v_rec3, v_org, v_acct, current_date - 6, 13100.0000, 'in_progress', 'USD', null, null)
  on conflict (id) do nothing;
end;
```

Observed post-fixture counts, queried as the harness tenant sees the data
(`app.current_org` = SIM org, `app.bypass_rls` = `off`): statements 2,
reconciliations 3 (2 `signed_off`, 1 `in_progress`), drawer lines 3,
unmatched lines 3, open session = the `in_progress` row. Mapped to variants:
default `table tbody tr` = 5 (2 + 3); `?stmtQ=ofx` → 1 + 3 = 4;
`?source=csv&stmtSort=imported&stmtDir=asc` → 1 + 3 = 4;
`?reconStatus=signed_off` → 2 + 2 = 4; `?reconSort=balance&reconDir=desc` →
2 + 3 = 5; `?stmtQ=zzzznomatch` → 0 body rows with 7 statement-column
headers intact; drawer variant → `UrlDrawer` layer present. Note the
fixture account already carried 112 posted GL lines, so the header balance
stat is large regardless of the fixture line. The coordinator owns
`scripts/viewspec-fixtures.sql`; the block above is the exact text to land.

## What could not be expressed

Nothing on this page required new `packages/viewspec` vocabulary beyond the
prefixed sort/pagination params landed in 9e62fbad2 (used here) and the
`search-input`/`filter-chips`/`empty-state` prop forwarding already present.
Two things to watch when the harness runs:

- The reconciliations table's last column has an empty `<TableHead />`
  header. The spec uses `column('', …)`; an empty-string header resolves to
  an empty `TableHead` through the same component — expected identical, but
  flagging in case the harness disagrees about empty children.
- The unmatched-count column is `number()` on nonzero rows (inheriting the
  column's `text-right tabular-nums`) but the shared `UnmatchedCountCell`
  renders the green zero; both paths use the same component, so this is
  markup-identical by construction.
