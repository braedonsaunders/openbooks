# /accounting ViewSpec integration handoff

Page: `/accounting` — the Accounting module home (financial-control cockpit).
Same archetype as `/purchasing`: ViewSpec composes the GRID and the PANELS
(`stat-tile` / `panel` blocks render the shared `HomeStatTile` / `HomePanel`
both paths already use); the bespoke panel bodies stay components in
`./sections`, shared by both render paths so they cannot drift.

Files created (all inside `web/app/(app)/accounting/`, the only dir this page owns):

- `view.ts` — `loadAccounting(sp)` + `accountingSpec(data)`. The loader copies
  the native page's permission gates (`gl.read`/`close.read`/`reports.read`
  union with `assertCan`), default-period resolution, `accountingHome` +
  `financialHealth` + `resolveNav` fan-out, directory badge logic, graded-ratio
  sort, and attention assembly VERBATIM; all tones/accents/grades are resolved
  to strings in the loader. `fmtRatio` is a verbatim copy of the native helper.
- `sections.tsx` — `HealthHero` (gauge + category bars + ratio table +
  deep-link footer) and `AttentionList` (with the native `.slice(0, 6)` moved
  INSIDE so both paths share it). The native `page.tsx` imports both back, so
  the native branch renders the same components rather than a second copy.
- `page.tsx` — viewspec branch added FIRST in the component body (takes
  optional `searchParams`, matching the close/purchasing convention); native
  branch unchanged apart from rendering the shared components.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { HealthHero, AttentionList as AccountingAttentionList } from '../../app/(app)/accounting/sections'

/* --- accounting cockpit -------------------------------------------------- */
'health-hero': (props) => (
  <HealthHero
    gaugeValue={typeof props.gaugeValue === 'number' ? props.gaugeValue : 0}
    gaugeLabel={str(props, 'gaugeLabel') ?? ''}
    categories={props.categories as ComponentProps<typeof HealthHero>['categories']}
    ratios={props.ratios as ComponentProps<typeof HealthHero>['ratios']}
    ratioLabels={props.ratioLabels as ComponentProps<typeof HealthHero>['ratioLabels']}
    fullAnalysisLabel={str(props, 'fullAnalysisLabel') ?? ''}
  />
),
```

`'module-home-tabs'`, `'attention-list'` (purchasing's — identical markup AND
identical contract: `{ items, allClear }`, slice-inside), and
`'directory-section'` already exist and need no change. The spec reuses them.
(`AccountingAttentionList` is imported only to document the contract match —
do NOT register a second attention widget; point the spec's `attention-list`
at the existing one. The import above is illustrative, not required.)

## What the coordinator must NOT create

No new slot is needed. The page takes no query params on either path (the
loader signature accepts `sp` only for the harness `__viewspec` flag
convention), and everything permission- or session-derived (authz, org id,
subsidiary scope, money formatter) is resolved inside `loadAccounting`, which
is server code — never through spec props. The Gauge import inside
`./sections` is the same `../analytics/_ui/Gauge` the native page already
used; no registry-level import is required beyond the section itself.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/accounting',
  // Module-home cockpit: hero panel (gauge + graded ratio table) plus the
  // rail. No query variants — the page reads no search params.
  variants: [''],
  // The hero ratio table. Graded-row floor is structural (see verification):
  // 3 always-finite P&L margins + 4 always-finite operating ratios.
  expect: 'table tbody tr',
  minMatches: 5,
},
```

Verified against the database (`openbooks_sim_viewspec`, harness user
`viewspec@sim.test`, org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, role `admin`):

- Page gate: admin holds `gl.read` (union gate passes on the first clause).
- `journal_entries` posted/reversed in range: **429** rows, so the P&L inputs
  (revenue/cogs/opex) are real, not zeros.
- Posted draft journals (`journal_entries`, status `draft`): **0** → the
  draft-tile warning branch and the draft attention row are NOT exercised;
  both render through shared components so the markup is identical by
  construction.
- Close runs: **0** → `progressPct` is null, exercising the `noClose` /
  `noCloseSub` tile branch.
- `ai_work_items` open: **critical 2, info 1, warning 0** → the negative-tone
  critical attention row IS exercised; the warning row is not.
- Accounts (non-summary, active): **66**; budget scenarios: **3**; fixed
  assets: **0** — directory badges render with live counts.
- Ratio-row floor (by code reading of `mk`/`scoreOf`/`grade` in
  `web/lib/analytics/financial-health.ts`): a ratio is graded iff its value is
  non-null and finite. Gross/operating/net margin and cogs/opex/leverage/rule-40
  are always finite (zero-safe guards on every divisor), so **≥ 7** hero rows
  render in every tenant; with 429 posted entries the sim tenant grades more
  (ebitda, balance-sheet and headcount ratios as inputs allow). `minMatches: 5`
  is conservative against that floor.
- No fixture SQL is proposed: every exercised branch above already has sim data.
  The unexercised branches (draft tile warning, warning-tone attention) need no
  fixture block — they are shared-component markup, not re-expressed spec.

## Could not express

Nothing structural. The hero ratio table is deliberately a widget, not a
`table` block: it is a plain hand-styled `<table>` (sticky thead, no card
chrome, no sort/pagination contract), matching neither the `app` nor the
`report` variant — the same reason the admin-users page hand-rolls its table
into a widget. The directory heading + `LiveDirectory` pair reuses the existing
`directory-section` widget (presence-gated by `hasDirectory`, since the native
page renders nothing when the directory is empty).
