# INTEGRATION — `/banking/[accountId]/reconcile/[reconciliationId]` ViewSpec conversion

Page: `web/app/(app)/banking/[accountId]/reconcile/[reconciliationId]/page.tsx`
Loader/spec: `./view.ts` (`loadReconciliation`, `reconcileSpec`)
Shared header pieces: `./sections.tsx` (`ReconcileStatusBadge`, `ReconcileStats`)

The page is a header plus one stateful workspace, the same archetype as
`/banking/match` (see `../../match/view.ts` for the division and its
rationale): ViewSpec composes the `page-header` and the four stat tiles, and
the `ReconcileWorkspace` stays whole. It owns radio/checkbox selection across
three independently paginated panes, the match/unmatch/auto-match/sign-off/
discard/adjust calls, and its adjust `Drawer` — decomposing it would strand
the selection from the actions it drives, and its per-row client selection
state is not something a `table` block can express.

## Widget registry entries to add (coordinator)

The spec references three widgets that do not exist yet. All render existing
components verbatim — no new markup invented here.

```tsx
import { ReconcileStats, ReconcileStatusBadge } from '../../app/(app)/banking/[accountId]/reconcile/[reconciliationId]/sections'
import { ReconcileWorkspace } from '../../app/(app)/banking/[accountId]/reconcile/[reconciliationId]/ReconcileWorkspace'

// Header status badge. One widget, not a spec badge cell: the native chrome
// is the shared `Badge` component (the page-header actions slot takes JSX),
// and the loader resolves both the translated-or-raw label and the variant.
'reconcile-status-badge': (props) => (
  <ReconcileStatusBadge
    label={str(props, 'label') ?? ''}
    variant={(str(props, 'variant') ?? 'secondary') as 'success' | 'warning' | 'secondary'}
  />
),
// Header stat tiles. One widget, not four: the native tiles are plain
// bordered divs with a conditional pair inside the difference tile (green
// zero vs amber nonzero `DifferenceBadge` — a component, not a spec
// construct), and `stat-tile` renders the cockpit `HomeStatTile` —
// different markup. The loader resolves every string; the only decision
// left (which difference tone) lives here, in the shared component.
'reconcile-stats': (props) => (
  <ReconcileStats
    statementBalanceLabel={str(props, 'statementBalanceLabel') ?? ''}
    statementBalanceValue={str(props, 'statementBalanceValue') ?? ''}
    clearedBalanceLabel={str(props, 'clearedBalanceLabel') ?? ''}
    clearedBalanceValue={str(props, 'clearedBalanceValue') ?? ''}
    differenceLabel={str(props, 'differenceLabel') ?? ''}
    difference={str(props, 'difference') ?? '0'}
    differenceCurrency={str(props, 'differenceCurrency') ?? ''}
    matchedLabel={str(props, 'matchedLabel') ?? ''}
    matchedValue={str(props, 'matchedValue') ?? ''}
  />
),
// The matching workspace, placed whole like `match-workspace`: it owns
// selection state across three prefixed panes plus every mutation. Flat
// props — each prop is passed straight through to the same-named
// `ReconcileWorkspace` prop (no wrapping object), following the
// `match-workspace` precedent. `canReconcile` is a loader-resolved boolean,
// never an Authz; the mutations ride the session cookie inside the shared
// component.
'reconcile-workspace': (props) => (
  <ReconcileWorkspace
    basePath={str(props, 'basePath') ?? ''}
    accountPath={str(props, 'accountPath') ?? ''}
    currentParams={(props.currentParams as ComponentProps<typeof ReconcileWorkspace>['currentParams']) ?? {}}
    reconciliation={props.reconciliation as ComponentProps<typeof ReconcileWorkspace>['reconciliation']}
    difference={str(props, 'difference') ?? '0'}
    canReconcile={props.canReconcile === true}
    stmtRows={(props.stmtRows as ComponentProps<typeof ReconcileWorkspace>['stmtRows']) ?? []}
    stmtTotal={Number(props.stmtTotal ?? 0)}
    stmtParams={props.stmtParams as ComponentProps<typeof ReconcileWorkspace>['stmtParams']}
    glRows={(props.glRows as ComponentProps<typeof ReconcileWorkspace>['glRows']) ?? []}
    glTotal={Number(props.glTotal ?? 0)}
    glParams={props.glParams as ComponentProps<typeof ReconcileWorkspace>['glParams']}
    matchedRows={(props.matchedRows as ComponentProps<typeof ReconcileWorkspace>['matchedRows']) ?? []}
    matchedTotal={Number(props.matchedTotal ?? 0)}
    mParams={props.mParams as ComponentProps<typeof ReconcileWorkspace>['mParams']}
  />
),
```

No new vocabulary. The spec uses only existing blocks: `page-header` (with
a `back` link and one action widget — no `actionsClassName`, the native
header renders the Badge unwrapped) and `widget`/`widget-block`.

Two fidelity notes, both verified against the renderers:

- `ReconcileStats`/`ReconcileStatusBadge` carry the native `STAT`/`STAT_LABEL`
  class strings verbatim (moved, not copied — `page.tsx` imports them back),
  including the `tabular-nums` on the three money tiles. `DifferenceBadge`
  keeps its own `useMoney(currency)` formatting; the spec passes it the
  loader's `difference` string and `recon.currency` unchanged.
- The spec passes `canReconcile` but the sign-off/action gating also depends
  on `signed_off` status and the zero-difference check — all of which live
  inside the shared workspace component on both paths, so there is no
  loader/spec skew by construction.

## Proposed conformance entry (coordinator)

The harness user (`viewspec@sim.test`, admin on the SIM org) has
`banking.read` + `banking.reconcile`. The SIM org's 1010 Operating Account
(`a1f8e08f-…`) holds 2 statements, 3 reconciliations (2 `signed_off`, 1 open
`in_progress` `…0407`, through `2026-09-03`) from the account-page fixture,
plus the matched-pair fixture below, so every loader branch resolves
non-degenerate: open session (action toolbar + both open panes + matched
pane), signed-off session (success alert, no panes, matched pane), status
badge variants, and the prefixed `stmt*`/`gl*`/`m*` search paths.

```js
{
  // Open reconciliation session: header stats + stateful matching workspace.
  path: '/banking/a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e/reconcile/00000000-0000-7000-9000-000000000407',
  variants: [
    // Open session: toolbar buttons, both panes, matched pair.
    { query: '', expect: 'main button', minMatches: 4 },
    // Prefixed search paths: the bank pane narrows to its pre-existing
    // unmatched line (the fixture matches a NEW line, so this survivor is
    // stable with or without the fixture applied).
    { query: '?stmtQ=Unmatched+deposit', expect: 'main table tbody tr', minMatches: 1 },
    // Matched-pane search narrows to the fixture pair.
    { query: '?mQ=BNK-REC', expect: 'main table tbody tr', minMatches: 1 },
  ],
  expect: 'main button',
  minMatches: 4,
},
{
  // Signed-off session: success alert + matched pane, no toolbar, no open
  // panes. A variant that cannot differ from the default is not coverage;
  // a separate entry is required because variants are query strings only
  // (the harness builds path + query) and this exercises the loader's
  // signed_off short-circuit plus the success badge variant.
  path: '/banking/a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e/reconcile/00000000-0000-7000-9000-000000000405',
  variants: [
    { query: '', expect: 'main table tbody tr', minMatches: 1 },
  ],
  expect: 'main table tbody tr',
  minMatches: 1,
},
```

Row counts verified against the database as the harness tenant sees it
(`app.bypass_rls` = `on`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`): open recon `…0407` → stmt pane 1
(`Unmatched deposit`, the only unmatched line at or before the `2026-09-03`
cutoff — the fixture below matches a NEW line so this survivor is stable),
GL pane 113 unreconciled unclaimed posted lines, matched pane 0 before the
fixture / 1 after (the fixture pair). Default-variant `main button` count:
Auto-match, Adjust, Discard, Match selected, Sign off = 5 (≥ 4) — toolbar
buttons do not depend on row counts. `?stmtQ=Unmatched deposit` → 1 stmt
row + the full GL table + matched rows (≥ 1 with or without the fixture);
`?mQ=BNK-REC` → requires the fixture (1 matched row), and also renders the
1 stmt row + GL table so `minMatches: 1` holds regardless. Both search
variants pin the paged table path rather than an exact row total, so the
113-row GL pane cannot make the counts brittle. Signed-off recon `…0405` →
stmt/GL panes short-circuit to zero rows (the alert replaces the toolbar),
matched pane 0/1 (≥ 1 only after the fixture — without it, lower to the
`thead th` header assertion or land the fixture first). All message keys
used (`banking.reconcile.*`, `banking.reconStatus.*`,
`banking.labels.statementBalance`) already exist in
`web/messages/en/banking.json` — verified by enumeration, none invented.

## Fixture (already in the coordinator's hands — proposed SQL)

The account-page fixture block (`…0401-0499`) leaves `reconciliation_matches`
empty, so the matched pane — the page's third list and its `m*` prefixed
params — would only ever render its empty state, which the harness refuses
to compare. Proposed addition to `scripts/viewspec-fixtures.sql`, claiming a
fresh id block `…0430-0439` (verified free: no `00000000043*` id appears in
the fixtures file or the conformance script). It inserts a NEW statement
line plus a NEW balanced two-leg entry and matches them inside the open
session — never touching the pre-existing `…0412 Unmatched deposit` line,
so the stmt pane, the account page's unmatched-lines stat, and the `?stmtQ`
search variant are identical with or without the fixture applied.

Guard-before-insert (not `ON CONFLICT DO NOTHING`): the statement-line
guard trigger (`matched line requires reconciliation-match evidence` /
`line with match evidence must remain matched`) and the posted-line guard
`jl_guard` both RAISE on a repeated write even when every row would be a
no-op — the banking block in this file documents the same pattern for
posted journal lines. Idempotence is checked before each statement, not by
it. Likewise the match insert runs only when the journal leg is still
unclaimed (unique index `recon_matches_one_journal_claim`).

```sql
-- ---- reconciliation-session matched pane -------------------------------
-- One manual match inside the open `in_progress` session (…0407) on the SIM
-- 1010 Operating Account, so the reconcile workspace renders its matched
-- pane and the `m*` prefixed search/sort path. A NEW statement line and a
-- NEW balanced entry — the pre-existing unmatched line (…0412) stays
-- unmatched, so the stmt pane and the account page's unmatched stat are
-- unchanged with or without this block. Post-fixture shape: open recon
-- stmt pane still 1, matched pane 0 → 1, signed-off recons untouched.
declare
  v_acct  uuid := 'a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e'; -- SIM 1010 Operating Account (asset_bank)
  v_stm1  uuid := '00000000-0000-7000-9000-000000000403'; -- fixture ofx statement, holds the new line
  v_rec   uuid := '00000000-0000-7000-9000-000000000407'; -- open in_progress session
  v_line  uuid := '00000000-0000-7000-9000-000000000434';
  v_je    uuid := '00000000-0000-7000-9000-000000000430';
  v_jl    uuid := '00000000-0000-7000-9000-000000000431';
  v_jl2   uuid := '00000000-0000-7000-9000-000000000432';
  v_match uuid := '00000000-0000-7000-9000-000000000433';
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
    raise notice 'missing reconcile-workspace fixture prerequisites; skipping';
    return;
  end if;

  -- The new statement line arrives unmatched (INSERT is unrestricted) and
  -- posts the same day as the entry below, inside the session's through-date,
  -- so the match guard's tenant / account / currency / cutoff check passes.
  -- bank_transaction_id stays null: the per-account source-id unique index
  -- only constrains non-null keys.
  insert into bank_statement_lines
    (id, org_id, statement_id, account_id, line_number, posted_on, amount, currency, description, match_status)
  values (v_line, v_org, v_stm1, v_acct, 4, current_date - 17, 750.0000, 'USD', 'Fixture paired deposit', 'unmatched')
  on conflict (id) do nothing;

  -- Balanced two-leg entry drafted then posted (the balanced-entry guard
  -- rejects a one-legged posting). Guarded by existence: once posted,
  -- jl_guard RAISEs on a repeated line insert even when every row would be
  -- a no-op.
  if not exists (select 1 from journal_entries where id = v_je) then
    insert into journal_entries (id, org_id, book_id, entry_number, posting_date, period_id, status, subsidiary_id)
    values (v_je, v_org, v_book, 'BNK-REC-1', current_date - 17, v_per, 'draft', v_sub);
    insert into journal_lines (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id)
    values (v_jl, v_org, v_je, 1, v_acct, 750.0000, 'USD', 750.0000, v_sub),
           (v_jl2, v_org, v_je, 2,
            (select id from accounts where org_id = v_org and number = '3900' limit 1),
            -750.0000, 'USD', -750.0000, v_sub);
    update journal_entries set status = 'posted', posted_at = now(), posted_by = v_user
     where id = v_je and status <> 'posted';
  end if;

  -- Match the pair. The line guard requires match evidence for a 'matched'
  -- line and forbids clearing it while evidence exists, so the match row
  -- goes in BEFORE the status flip, and each step guards before writing:
  -- the match insert only when the journal leg is still unclaimed, the flip
  -- only while the line is still unmatched.
  if not exists (select 1 from reconciliation_matches where id = v_match)
     and not exists (select 1 from reconciliation_matches where journal_line_id = v_jl) then
    insert into reconciliation_matches (id, org_id, reconciliation_id, statement_line_id, journal_line_id, matched_by)
    values (v_match, v_org, v_rec, v_line, v_jl, 'manual');
  end if;
  update bank_statement_lines set match_status = 'matched', updated_at = now(), updated_by = v_user
   where id = v_line and org_id = v_org and match_status = 'unmatched'
     and exists (select 1 from reconciliation_matches where statement_line_id = v_line and org_id = v_org);
end;
```

Post-fixture effect on the harness tenant's counts: open recon matched
pane 0 → 1; stmt pane stays 1 (`Unmatched deposit` survives); GL pane
113 → 112 (the fixture leg is now claimed — the variant asserts a floor,
not an exact total, so this is safe); the account page's unmatched-lines
stat stays 3 (one line flips to matched, one new unmatched line arrives).
The coordinator owns `scripts/viewspec-fixtures.sql`; the block above is
the exact text to land. **This block was NOT executed against the
conformance database** (fixture writes belong to the coordinator's
controlled apply) — counts above combine observed pre-fixture data with the
block's deterministic effect.

## What could not be expressed

Nothing structural. Three judgment calls, all documented in `view.ts`:

1. The `ReconcileWorkspace` is ONE `reconcile-workspace` widget over
   loader-fetched rows and pane params — its tables carry per-row client
   selection state and its panes drive shared match/sign-off actions, which
   is a workspace, not a spec.
2. The header badge is ONE `reconcile-status-badge` widget — a translated
   label plus a variant flip, which is a conditional pair in shared chrome,
   not a spec construct.
3. The four stat tiles are ONE `reconcile-stats` widget — the difference
   tile's green/amber pair is a component decision, and `stat-tile` renders
   the cockpit `HomeStatTile`, which is different markup.
