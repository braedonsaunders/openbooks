# INTEGRATION — `/banking/cash` ViewSpec conversion

Page: `web/app/(app)/banking/cash/page.tsx`
Loader/spec: `./view.ts` (`loadBankingCash`, `bankingCashSpec`)
Shared sections: none — no `sections.tsx` (see below)

The page is a cash control center — the same archetype as the AR cockpit
(see `../../ar/view.ts` for the division and its rationale): ViewSpec binds
the header (title, description, subsidiary switcher, route tabs); the cockpit
BODY stays one client component, shared by both render paths so it cannot
drift. The horizon switcher, vitals strip, negative-cash alert, five
user-reorderable panels (weekly timeline with per-transaction flyout,
forecast + bridge charts, health vitals, bank accounts) with prefs persisted
to `user_page_layouts`, and the forecast-config drawer are client navigation
and client state a spec cannot name.

## Widget registry entries to add (coordinator)

The spec references one widget that does not exist yet, alongside two
already-registered ones (`subsidiary-switcher`, `module-home-tabs` — no
change needed). It renders the existing component verbatim — no new markup
invented here.

```tsx
import { CashCockpit } from '../../app/(app)/banking/cash/CashCockpit'

// Cash control center body. A WIDGET, not a slot: the loader already
// performed the cockpit's server work (permission gates, subsidiary scoping,
// cash position, the user_page_layouts prefs fetch — capabilities the LOADER
// may hold) and passes the results through as data, so no user id, org id or
// Authz crosses the spec. Layout persistence rides the session cookie inside
// the shared component.
'cash-cockpit': (props) => (
  <CashCockpit
    data={props.data as ComponentProps<typeof CashCockpit>['data']}
    layoutPrefs={props.layoutPrefs as ComponentProps<typeof CashCockpit>['layoutPrefs']}
    canConfigure={props.canConfigure === true}
    canPayRun={props.canPayRun === true}
    canCollectionRun={props.canCollectionRun === true}
  />
),
```

Prop shape (flat props, NOT one object): the widget receives five top-level
props — `data` (the full `CashPosition`: `asOf`, `horizonWeeks`,
`startingCash`, `bankAccounts[]`, `weeks[]` with totals/counts but emptied
entry arrays, `totalInflows`/`totalOutflows`, `netChange`, `projectedEnd`,
`lowestCash`/`lowestWeek`, `burnRate`, `runwayWeeks`/`runwayStatus`,
`deferredBeyondHorizon`, `dso`/`dpo`, `arOutstanding`/`apOutstanding`,
`arCoverage`, `categories[]`, `apSettings`, `vendorOptions`,
`accountOptions`), `layoutPrefs` (`{ order?, hidden? }`), `canConfigure`,
`canPayRun`, `canCollectionRun` (booleans). This matches the native
`<CashCockpit data layoutPrefs canConfigure canPayRun canCollectionRun />`
call site exactly.

No new vocabulary. The spec uses only existing blocks: `page-header` (with
`actionsClassName`, exactly as the banking/purchasing cockpits do) and
`widget`/`widget-block`.

## Proposed conformance entry (coordinator)

The harness user (`viewspec@sim.test`, admin on the SIM org) has
`banking.read`. The SIM org (`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`) holds 3
bank accounts (1010 Operating 890334.5744, 1020 Payroll 0, 1030 Contract
Reserve 910000.0000 — the accounts panel renders non-empty), 42 customer
invoices + 238 vendor bills (non-degenerate AR/AP forecast input), and no
forecast categories (stored in `orgs.settings`, empty for the SIM org — the
timeline's Other In/Out columns stay hidden). The `horizon` variants pin the
page's one query branch (4/12 accepted, anything else → 8): variant 1 pins
non-default acceptance, variant 2 pins the default fallback, and both assert
the header + cockpit shell rather than amounts.

```js
{
  // Cash control center: header (title + subsidiary switcher + route tabs)
  // with the whole cockpit behind one client widget.
  path: '/banking/cash',
  variants: [
    // ?horizon=4: non-default horizon accepted; header h1 + hero h3s render.
    { query: '?horizon=4', expect: 'main h1, main h3', minMatches: 4 },
    // Default horizon (8): same shell, default branch of the horizon parse.
    { query: '', expect: 'main h1, main h3', minMatches: 4 },
  ],
  expect: 'main h1, main h3',
  minMatches: 4,
},
```

`minMatches: 4` counts the page-header `h1` plus the five reorderable panel
`h3`s minus layout variance (all five visible by default: timeline,
forecast, bridge, health renders `div` not `h3`, accounts — plus the Layout
menu is a button, not a heading; the vitals strip renders no headings). The
conservative floor of 4 (1 h1 + 3 of the 4 panel h3s) holds under any default
order. All message keys used (`banking.cash.title/description`,
`banking.home.subsidiary`) already exist in `web/messages/en/banking.json` —
verified by enumeration, none invented.

## Fixture (none needed)

No new fixture SQL. The page renders its full shape — header, vitals strip,
timeline, charts, health vitals, accounts panel — on the existing SIM tenant
as-is: 3 bank accounts with positive GL balances, 42 open customer invoices
and 238 vendor bills feeding the forecast. No fresh id block is claimed from
the allocation table in `scripts/viewspec-fixtures.sql`.

## What could not be expressed

Nothing structural. Three judgment calls, all documented in `view.ts`:

1. The cockpit body is ONE `cash-cockpit` widget over the loader-projected
   position, not a decomposed grid — its panel order/visibility is per-user
   client state with optimistic persistence, its week drill fetches on
   demand, and its charts are memoized option objects, which is a workspace,
   not a spec.
2. No `sections.tsx`: the cockpit's panels render `StatTile`/`CockpitPanel`/
   `Vital`/`CashTimeline`/`Chart` directly with mixed client formatting
   (`useMoney` compact money, client-locale dates), so there is no
   spec-composable markup to share back — both render paths import the same
   `CashCockpit`.
3. `lowestDate` is formatted CLIENT-side (`toLocaleDateString('en-US', …,
   UTC)`) in `CashCockpit`, so the loader passes the raw `lowestWeek` ISO
   string through inside `data` and the component formats it — per the
   client-formatting trap, the loader does NOT pre-format it.
