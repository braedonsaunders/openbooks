# /close ViewSpec integration handoff

Only the LIST branch (`/close` without a resolving `?run=`) is converted.
The run branch (`?run=<uuid>` naming a row) renders `CloseWizard` and stays
native — see "What could not be expressed" below.

## Widget registry entries (for the coordinator)

Imports (all already imported by `web/components/viewspec/widgets.tsx`
except where noted):

```tsx
import { Button } from '@openbooks/ui'
import Link from 'next/link'
import {
  CloseActionCell,
  CloseReadinessCell,
  SingleBookLabel,
} from '../../app/(app)/close/sections'
import { StartCloseButton } from '../../app/(app)/close/StartCloseButton' // NEW import
```

Entries:

```tsx
/**
 * The /close "Manage books" header action. Native markup is
 * `<Button variant="outline" size="sm" asChild><Link …/></Button>` —
 * default size would render h-10 instead of h-8, so `size: 'sm'` is
 * load-bearing, not decoration.
 */
'manage-books-button': (props) => {
  const href = str(props, 'href')
  if (!href) return null
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href as never}>{str(props, 'label') ?? ''}</Link>
    </Button>
  )
},
/** The single-book pill shown when the org has ≤1 active book. */
'single-book-label': (props) => (
  <SingleBookLabel label={str(props, 'label') ?? ''} name={str(props, 'name') ?? ''} />
),
/** The readiness bar beside its percentage. */
'close-readiness-cell': (props) => (
  <CloseReadinessCell readiness={Number(props.readiness ?? 0)} />
),
/**
 * The action cell's conditional triple: resume link / start control /
 * em-dash. The LOADER decides which of the three applies; the component
 * only renders the decision it is given. `StartCloseButton` keeps its own
 * permission-agnostic client behaviour exactly as on the native path.
 */
'close-action-cell': (props) => (
  <CloseActionCell
    actionHref={(props.actionHref as string | null) ?? null}
    actionLabel={str(props, 'actionLabel') ?? ''}
    actionLinkClassName={str(props, 'actionLinkClassName') ?? ''}
    canStart={props.canStart === true}
    startPeriodId={str(props, 'startPeriodId') ?? ''}
    startBooks={(props.startBooks as { id: string; name: string }[]) ?? []}
    startDefaultBookId={str(props, 'startDefaultBookId') ?? ''}
  />
),
```

Two existing widgets need new optional props (no behaviour change for
current callers):

- `filter-chips`: `hideAll` (boolean) and `defaultValue` (string). The
  /close book and fy chips both pass `hideAll` (the "All" option is hidden;
  the control always has a selection) with `defaultValue` set exactly as the
  native page does (`selectedBookId` / `String(currentFy)`). Both must flow
  straight through to `FilterChips`, which already accepts them.

## Proposed conformance registry entry

```js
{
  path: '/close',
  // Three rows in the sim tenant (FY 2026, single book, all not_started,
  // each with journal entries). Variants pin the real branches: the default
  // list, a search that narrows to one row, and a status filter.
  variants: [
    '',
    { query: '?q=2026-02', expect: 'table tbody tr', minMatches: 1 },
    { query: '?status=not_started', expect: 'table tbody tr', minMatches: 3 },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

Verified against the database (`openbooks_sim_viewspec`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, book
`b6f2482d-d861-4f6e-948d-ca2845284062`):

- `2026-01 / not_started / 62 entries`, `2026-02 / not_started / 157`,
  `2026-03 / not_started / 210` — so the default variant renders 3 rows.
- `?q=2026-02` matches 1 row; `?status=not_started` matches all 3.
- The sim org has exactly one active book, so the book axis renders the
  single-book pill (not chips); its only fiscal year is 2026. The harness
  user (`viewspec@sim.test`, `admin` role) holds `close.read`,
  `close.run`, and `admin.setup.manage`, so the start control and the
  Manage books button both render.
- Default `fy` is `currentFiscalYear()` (today-driven, January start month
  for the sim org → 2026). If the sim clock moves into FY 2027 the default
  variant renders 0 rows and this entry needs a `?fy=2026` pin.

Deliberately NOT covered: `?run=<id>` — the run branch stays native (the
spec path returns null there by design; the harness's proof-of-path check
would fail on it). No `close_runs` fixture is seeded for this page.

## What could not be expressed

1. **The run branch (`CloseWizard`).** ~1100-line client component with its
   own `WizardLayout` shell, six stage bodies, and run actions. No
   `PageLayout` value expresses `WizardLayout` (sticky header + scrollable
   body, no footer, wide column), and decomposing the stages into blocks
   would reimplement the wizard rather than compose it. Per the brief
   ("if the page needs vocabulary that does not exist yet, stop and report
   it rather than inventing it"), the spec carries an `onRun`-gated
   `close-wizard-slot` placeholder — deliberately NOT registered, so it
   fails closed if ever rendered — and `page.tsx` keeps the wizard on the
   native path. A future `wizard` layout + stage vocabulary is the
   coordinator's call, not this page's.
2. **`hideAll` / `defaultValue` on `filter-chips`.** Needed, proposed above;
   not a new block, just two props the underlying `FilterChips` already
   takes.
3. **Nothing else.** Search, status chips, the app table, and the pager all
   use existing vocabulary. No new message keys (every `t('…')` call lives
   in the loader and matches keys the native page already uses).
