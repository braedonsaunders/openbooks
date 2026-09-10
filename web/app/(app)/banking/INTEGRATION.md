# INTEGRATION — `/banking` ViewSpec conversion

Page: `web/app/(app)/banking/page.tsx`
Loader/spec: `./view.ts` (`loadBanking`, `bankingSpec`)
Shared rail section: `./sections.tsx` (`BankingAttentionList`,
`BankingAttentionItem` — new; the roster panel and directory section are
reused from their owners, not copied)

The page is a module-home cockpit, the same archetype as `/purchasing` (see
`../../purchasing/view.ts` for the division and its rationale): ViewSpec
composes the grid and the panels; the panel BODIES stay components, shared by
both render paths so they cannot drift. `needsAttention`, `daysSince` and
`weekLabel` moved from `page.tsx` to `view.ts` and the native branch imports
them back.

## Widget registry entries to add (coordinator)

The spec references three widgets that do not exist yet, alongside four
already-registered ones (`subsidiary-switcher`, `module-home-tabs`,
`trend-chart`, `directory-section` — no change needed). All three render
existing components verbatim — no new markup invented here.

```tsx
import { AccountsRosterPanel } from '../../app/(app)/banking/AccountsRoster'
import { BankingAttentionList } from '../../app/(app)/banking/sections'
import { Button } from '@openbooks/ui'
import { ListChecks } from 'lucide-react'
import Link from 'next/link'

// Roster hero. A WIDGET, not a slot: the loader already performed the
// roster's server work (the user_page_layouts prefs fetch — a user
// capability the LOADER may hold) and passes the prefs through as data, so
// no user id, org id or Authz crosses the spec. Persistence rides the
// session cookie inside the shared component.
'banking-roster': (props) => (
  <AccountsRosterPanel
    accounts={props.accounts as ComponentProps<typeof AccountsRosterPanel>['accounts']}
    totalCash={Number(props.totalCash ?? 0)}
    totalCards={Number(props.totalCards ?? 0)}
    layoutPrefs={props.layoutPrefs as ComponentProps<typeof AccountsRosterPanel>['layoutPrefs']}
  />
),
// Header Match button: a conditional PAIR (count label when unmatched, plain
// label when clean) with a variant flip — a component, not a spec construct.
// The loader resolves every string; the only decision left (which label)
// lives here, in the shared chrome, not in the spec.
'banking-match': (props) => (
  <Button variant={(str(props, 'variant') ?? 'outline') as ComponentProps<typeof Button>['variant']} asChild>
    <Link href={(str(props, 'href') ?? '/banking/match') as never}>
      <ListChecks size={14} />
      {props.showCount === true ? str(props, 'countLabel') ?? '' : str(props, 'label') ?? ''}
    </Link>
  </Button>
),
// Needs-attention queue, INCLUDING its empty state. The empty case lives in
// the shared component rather than as a conditional pair of blocks — see
// ./sections.tsx (the purchasing precedent).
'banking-attention-list': (props) => (
  <BankingAttentionList
    items={(props.items as ComponentProps<typeof BankingAttentionList>['items']) ?? []}
    allClear={str(props, 'allClear') ?? ''}
  />
),
```

No new vocabulary. The spec uses only existing blocks: `page-header` (with
`actionsClassName`, exactly as the purchasing cockpit does), `grid`, `panel`,
`stat-tile`, and `widget`/`widget-block`.

Two fidelity notes, both verified against the renderers:

- The vitals strip is five `stat-tile` blocks over the same `HomeStatTile`
  the native page renders. The cash tile's non-negative tone is `neutral`
  (the native `tone={… ? 'negative' : 'neutral'}`), NOT `default` — `default`
  is not in the block's tone union and would also drop the subline's neutral
  classes. The unmatched tile carries NO tone (the native tile renders none;
  only its accent flips), and the open-recons tile carries none either.
- The directory reuses the shared `directory-section` widget from
  `purchasing/sections.tsx` (same `<div className="shrink-0">`-or-null pair
  the native page renders), not a copy. No `when` gate: the empty case lives
  inside that component.

## Proposed conformance entry (coordinator)

The harness user (`viewspec@sim.test`, admin on the SIM org) has
`banking.read` + `banking.reconcile`. The SIM org holds one reconcilable
account (1010 Operating Account, `asset_bank`), 2 statements (ofx + csv, from
the account-page fixture — reused, not duplicated), 3 unmatched lines, 1 open
`in_progress` reconciliation, 1 active + 2 total match rules, and a positive
GL balance with trailing-7-day flow, so every loader branch resolves
non-degenerate: Match button in count+default variant, cash tile neutral,
unmatched tile amber, net-flow tile emerald/positive, directory badges
`3/warning`, `1/neutral`, `1/rulesHint`, `2/importsHint`, one attention item
(the open recon; the balance is positive and the statements are ≤ 21 days, so
the negative-balance and stale-statement branches stay quiet).

```js
{
  // Banking cockpit: vitals strip, roster hero, trend, directory, attention.
  // No query params drive this page (subsidiary scoping rides ?sub=, covered
  // by the default render), so variants pin content branches instead.
  path: '/banking',
  variants: [
    // Default: 5 vitals tiles, roster section, trend, directory, attention.
    { query: '', expect: 'h2, h3', minMatches: 5 },
  ],
  expect: 'h2, h3',
  minMatches: 5,
},
```

Row counts verified against the database as the harness tenant sees it
(`app.bypass_rls` = `on`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`): reconcilable accounts 1; unmatched
lines 3; open (non-`signed_off`) reconciliations 1; active rules 1, total
rules 2; statements on active accounts 2, last import `2026-09-09` (yesterday
— imports badge neutral, not stale); GL balance 890334.5744 (positive —
cash tile neutral). Tabs: both banking tabs (`/banking`, `/banking/cash`)
render (feature `banking` on). Directory: 5 items after the
`/banking`+`/banking/cash` exclusion (match, reconciliations, rules,
imports, transactions). `minMatches: 5` counts panel/section headings
(roster bank section + trend + directory + attention + vitals labels render
as `h2`/`h3`), following the `/purchasing` precedent (`expect: 'h2, h3'`),
not table rows — this page has no table. All message keys used
(`banking.home.*`) already exist in `web/messages/en/banking.json` —
verified by enumeration, none invented.

## Fixture (none needed)

No new fixture SQL. The page renders its full shape — vitals, roster hero,
trend, directory, attention — on the existing SIM tenant plus the
account-page fixture block (`…0401-0499`: 2 statements, 3 unmatched lines,
1 open + 2 signed-off reconciliations). No fresh id block is claimed from
the allocation table in `scripts/viewspec-fixtures.sql`.

## What could not be expressed

Nothing structural. Three judgment calls, all documented in `view.ts`:

1. The roster hero is ONE `banking-roster` widget over loader-fetched prefs,
   not a decomposed list — its rows are per-row client state (hide/reorder
   with optimistic persistence), which is a workspace, not a spec.
2. The Match header button is ONE `banking-match` widget — a conditional pair
   with a variant flip, which is a component, not a spec construct.
3. `daysSince` runs against `Date.now()` in the loader, so the imports-badge
   age and stale-statement flags are computed at render time on both paths —
   identical by construction, and the harness compares the two renders
   against the SAME request.
