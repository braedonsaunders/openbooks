# INTEGRATION — `/banking/reconciliations` ViewSpec conversion

Page: `web/app/(app)/banking/reconciliations/page.tsx`
Loader/spec: `./view.ts` (`loadBankingReconciliations`, `bankingReconciliationsSpec`)
Shared sections: none — the page defines no local component, so there is no
`sections.tsx`. The empty-state action keeps its native `Button asChild` +
`Link` chrome inside the proposed widget below; no second copy is written
here.

## Widget registry entry to add (coordinator)

The spec references one widget that does not exist yet. The
`entity-list-view` widget is already registered (with
`web/components/viewspec/entity-list-slot.tsx` re-deriving org/user/permissions
from the session) and needs no change. The entry below renders the native
empty-action chrome verbatim — a `Button asChild` wrapping a `Link`, exactly
as `page.tsx` renders it today.

```tsx
import Link from 'next/link'
import { Button } from '@openbooks/ui'

// Empty-state action for /banking/reconciliations: a Button-as-child Link
// back to /banking. Loader-resolved href + label arrive as props because a
// spec cannot express JSX. The native page passes this action
// unconditionally (no permission gate), so the spec passes it unconditionally
// too — it is data, not a branch.
'choose-recon-account': (props) => (
  <Button asChild>
    <Link href={(str(props, 'href') ?? '/banking') as never}>{str(props, 'label') ?? ''}</Link>
  </Button>
),
```

EXACT prop shape: `{ href: string; label: string }`. The spec passes
`{ href: data.chooseAccountHref, label: data.chooseAccountLabel }` where
`chooseAccountHref` is the literal `'/banking'` and `chooseAccountLabel` is
`t('reconsPage.chooseAccount')`.

No new vocabulary. The spec uses only existing blocks: one `page-header`
with a back link (no actions — the native header renders none) and the
`entity-list-view` widget with no drawer and the widget-ref emptyAction.

## Proposed conformance entry (coordinator)

The harness user (`viewspec@sim.test`, admin on the SIM org) has
`banking.reconcile`. The SIM org holds 3 `bank_reconciliation` rows (from
the account-page fixture block `…0401-0499` — reused, not duplicated): 2
`signed_off`, 1 `in_progress`, all on the 1010 Operating Account, so the
default render, the status filter, the search, the sort, and the empty-search
path all resolve non-degenerate:

```js
{
  // Reconciliations across all accounts: the universal bank_reconciliation
  // entity list with a Button-as-child empty action and no drawer.
  path: '/banking/reconciliations',
  variants: [
    // Default: 3 reconciliation rows.
    { query: '', expect: 'table tbody tr', minMatches: 3 },
    // List branches: status filter narrows to the 2 signed-off rows; search
    // matches all 3 through the account number/name; sort exercises the
    // entity-list params.
    { query: '?status=signed_off', expect: 'table tbody tr', minMatches: 2 },
    { query: '?q=1010', expect: 'table tbody tr', minMatches: 3 },
    { query: '?sort=through&dir=asc', expect: 'table tbody tr', minMatches: 3 },
    // Empty-table path (table with zero body rows, not the empty state):
    // assert headers survive a search that matches nothing.
    { query: '?q=zzzznomatch', expect: 'table thead th', minMatches: 1 },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

Row counts verified against the database as the harness tenant sees it
(`app.bypass_rls` = `on`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`): all reconciliations 3
(`00000000-0000-7000-9000-000000000405/406` `signed_off`,
`00000000-0000-7000-9000-000000000407` `in_progress`);
`?status=signed_off` → 2; `?q=1010` → 3 (the search expr is
`r.through_date::text / bank_account.number / bank_account.name`, and all 3
rows sit on account 1010 Operating Account); `?q=zzzznomatch` → 0 body rows
with the column headers intact. The harness user exists
(`viewspec@sim.test`, 1 row). All message keys used
(`banking.reconsPage.title/description/chooseAccount`, `banking.home.title`)
already exist in `web/messages/en/banking.json` — verified by grep, none
invented.

## Fixture (none needed)

No new fixture SQL. The page renders its full shape — header, status chips
with visibility-filtered counts, account filter, 3-row table — on the
existing SIM tenant plus the account-page fixture block (`…0401-0499`: 2
statements, 12 lines, 3 reconciliations). No fresh id block is claimed from
the allocation table in `scripts/viewspec-fixtures.sql`.

## What could not be expressed

Nothing structural. Two judgment calls, both documented in `view.ts`:

1. The empty action is ONE `choose-recon-account` widget ref over
   loader-resolved href + label — a spec cannot express JSX, so the
   indirection is the same one the empty state already uses for its action.
2. The native page passes no drawer and no `formatValue` (rows link out to
   the per-account reconcile workspace via the source's own `rowHref`, and
   every cell is registry-typed), so the spec passes neither — nothing is
   precomputed in the loader that the list itself owns.
