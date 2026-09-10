# /admin/setup/readiness ViewSpec integration handoff

The page has no search params, no table, no drawer and no slots: the loader
re-derives nothing beyond the `admin.setup.manage` gate it already holds
(`requirePermission` throws, so there is no 404 branch — the gate is the
same on both paths). Everything is loader-resolved data bound to two new
widgets. No fixture SQL is seeded: the SIM org already renders all three
check states (see verification below).

## Widget registry entries (for the coordinator)

Imports (NEW — neither is imported by `web/components/viewspec/widgets.tsx`):

```tsx
import {
  SetupReadinessCheckCard,
  SetupReadinessHero,
} from '../../app/(app)/admin/setup/readiness/sections'
```

Entries:

```tsx
/**
 * The readiness hero card. Compared against reusing the existing
 * `readiness-panel` entry: that widget renders the compliance 1099 queue
 * (`HomePanel` with a ghost action button and `ReadinessQueueSection`
 * rows) — none of its markup matches this page's icon-tile header,
 * foundation badge, or progress bar. Separate widget, no shared code.
 */
'setup-readiness-hero': (props) => (
  <SetupReadinessHero
    kicker={str(props, 'kicker') ?? ''}
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    badgeLabel={str(props, 'badgeLabel') ?? ''}
    badgeReady={props.badgeReady === true}
    progressLabel={str(props, 'progressLabel') ?? ''}
    progressCount={Number(props.progressCount ?? 0)}
    progressTotal={Number(props.progressTotal ?? 0)}
    progressPercent={Number(props.progressPercent ?? 0)}
    progressMin={Number(props.progressMin ?? 0)}
    progressMax={Number(props.progressMax ?? 0)}
    progressNow={Number(props.progressNow ?? 0)}
  />
),
/**
 * One readiness check card. Flat props so the spec's `repeat` threads
 * per-item field refs straight through — the same threading the admin hub
 * cards use. `state` is a closed 'complete' | 'review' | 'waiting'
 * vocabulary resolved by the loader; the component switches icon and tile
 * classes on it, never the spec.
 */
'setup-readiness-check-card': (props) => (
  <SetupReadinessCheckCard
    indexLabel={str(props, 'indexLabel') ?? ''}
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    href={str(props, 'href') ?? ''}
    action={str(props, 'action') ?? ''}
    state={(str(props, 'state') === 'review' ? 'review' : str(props, 'state') === 'waiting' ? 'waiting' : 'complete')}
    stateLabel={str(props, 'stateLabel') ?? ''}
  />
),
```

No changes to existing registry entries are needed. `readiness-panel`
(compliance 1099 queue) is untouched.

## Proposed conformance registry entry

```js
{
  path: '/admin/setup/readiness',
  // Seven static checks; the page takes no query params, so the only
  // variant is the default. All three check states render in the SIM
  // tenant (see verification), and the hero + 7 cards are always present.
  variants: [''],
  expect: 'main div.space-y-6 div.space-y-3 div.rounded-lg',
  minMatches: 7,
},
```

Verified against the database (`openbooks_sim_viewspec`, SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, harness user
`viewspec@sim.test` holds the `admin` role → `admin.setup.manage`
passes, no 404 branch exists):

- `currencies=40, roots=1, accounts=66, books=1, periods=3`,
  `controlAccounts.{ar,ap,bank}` all set → `foundationReady=true`;
  `onboarding.setupComplete=true` but no `settings.workspaceProfile` →
  `profileReady=false`.
- Check states: profile `waiting`, foundation `complete`, invoicing
  (`payment_terms=0`) `review`, tax (`tax_codes=0`, no taxPosition →
  `unsure`) `review`, bank (`bank_accounts=1`) `complete`, cutover
  (`bookStart=fresh` default, `posted_entries=429`) `complete`, first
  close (`completed_closes=0`, `posted_entries=429`) `review` — 3
  complete, 3 review, 1 waiting.
- Progress: 3 of 7, 43%. Badge: `warning` / "Foundation needs
  attention" (`hardReady = profileReady && foundationReady = false`).
- 7 cards render; `main div.space-y-6 div.space-y-3 div.rounded-lg`
  matches one `.rounded-lg` Card per check (hero excluded by the
  `space-y-3` scope). No fixture block claimed.

## What could not be expressed

Nothing. The hero and check cards are domain components (conditional
icon pairs, badge variant, progress width), the checks list is a
`repeat` with `unwrapped`, and `layout: 'bare'` covers the setup-shell
nesting. No new message keys — all copy is loader-side literals copied
verbatim from the native page.
