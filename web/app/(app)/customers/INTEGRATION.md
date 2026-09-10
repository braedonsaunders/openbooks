# /customers ViewSpec integration handoff

The spec in `view.ts` needs TWO registry entries the coordinator owns
(`web/components/viewspec/widgets.tsx`). Everything else it places already
exists: `page-header` (+ `actionsClassName`), `grid`, `panel`, `stat-tile`
(with `when`), `trend-chart`, `subsidiary-switcher`, `module-home-tabs`,
`directory-section`, `attention-list`.

No `packages/viewspec` changes, no fixture SQL, no slot proposals.

## 1. `WIDGET_REGISTRY` entries (coordinator adds)

```tsx
import { RelationshipsSection, ArPulse } from '../../app/(app)/customers/sections'

/* --- customers cockpit ---------------------------------------------------- */
'relationships-section': (props) => (
  <RelationshipsSection
    rows={(props.rows as ComponentProps<typeof RelationshipsSection>['rows']) ?? []}
    crmEnabled={props.crmEnabled !== false}
    empty={str(props, 'empty') ?? ''}
  />
),
'ar-pulse': (props) => (
  <ArPulse
    outstanding={str(props, 'outstanding') ?? ''}
    overdue={str(props, 'overdue') ?? ''}
    overdueIsNegative={props.overdueIsNegative === true}
    dso={str(props, 'dso') ?? ''}
    labels={props.labels as ComponentProps<typeof ArPulse>['labels']}
    href={str(props, 'href') ?? ''}
  />
),
```

Byte-equivalence notes (checked against `page.tsx` + `sections.tsx`):

- `RelationshipsSection` IS the native hero: the native page renders
  `<RelationshipsSection rows empty>` in the same `HomePanel`
  (`title`/`icon="users"`/`hint`/`bodyClassName="min-h-0 overflow-y-auto p-0"`/`className="min-h-[24rem] lg:col-span-2"`),
  so the empty `<p className="px-6 py-16 …">` and the `RelationshipsTable`
  (with its `crmEnabled` open-opps column) are one shared implementation,
  not two copies. `crmEnabled` defaults true in the table component, so the
  widget coerces `!== false` rather than `=== true` to match.
- `ArPulse` IS the native pulse: same three-cell strip, same `cn` red toggle
  on the overdue figure, same `/ar${subQs}` CTA link. The `dso` prop carries
  the loader-resolved `'—'` / `t('home.vitals.days', { n })` string, so the
  widget has no conditional.
- The native page's rail directory + attention markup was replaced with the
  shared `DirectorySection` / `AttentionList` from `../purchasing/sections`
  (byte-identical markup: `shrink-0` div + `h3` + `LiveDirectory`; `ul`
  divide list with the `negative → bg-red-500` tone map). The spec therefore
  reuses the existing `directory-section` / `attention-list` widgets and the
  native branch renders the same components — no new entries needed.
- All message keys used by the loader already exist: verified against
  `web/messages/en/customers.json` (`home.title/description/subsidiary`,
  `home.vitals.*`, `home.hero.*`, `home.pulse.*`, `home.trend.*`,
  `home.directory.*`, `home.attention.*`).

## 2. Proposed conformance registry entry

Verified against `openbooks_sim_viewspec` (bypass RLS). The harness user
`viewspec@sim.test` holds the Administrator role in org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` (SIM · Summit Ridge Construction),
which passes the page's gate (`ar.read` present). Org features: `crm: true`,
`orders: true` (both vitals branches render), one active subsidiary (the
subsidiary switcher renders its single picker row).

```js
{
  path: '/customers',
  variants: [''],
  // The cockpit's hero table — proves the grid/panel composition rendered,
  // not just the page shell. Harness tenant holds 5 open-balance customer
  // parties (all 5 with overdue balances, so the attention rail is
  // non-empty too) and 5 active customers.
  expect: 'table tbody tr',
  minMatches: 5,
},
```

- `5` is the exact hero row count (parties with remaining open AR balance),
  not a loose lower bound: `minMatches: 5` fails if any hero row goes
  missing, and the simulator seeds these invoices deterministically.
- No query variants: the page reads only `sp.sub` (subsidiary scoping — the
  harness org has a single active subsidiary, so `?sub=` selects nothing
  distinct) and `__viewspec`. There is no search/sort/filter/pager branch to
  exercise, and no drawer/flyout (the `EntityDrawer` opens client-side on row
  click and is not a route variant).
- No fixture SQL: the hero (28 open `customer_invoice` docs, 42 open AR
  lines), the 13-week collections trend (10 posted `customer_payment` docs),
  the 5-customer directory badge, and the CRM pipeline pair (2 active open
  opportunities) all already exist in the harness tenant. No allocation-block
  claim needed.

## 3. What could not be expressed

Nothing. The whole page is expressible: grid/panel/stat-tile composition for
the vitals, one widget per bespoke panel body, and existing widgets for the
trend chart, directory, and attention rail. No new ViewSpec vocabulary
proposed.
