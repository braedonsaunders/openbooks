# /analytics ViewSpec integration handoff

The spec in `view.ts` needs ONE frame and ONE registry entry the coordinator
owns (`web/components/viewspec/blocks.tsx` frames, `web/components/viewspec/widgets.tsx`).
No `packages/viewspec` changes, no fixture SQL, no slot proposals.

## 1. `FRAME_REGISTRY` entry (coordinator adds)

The native page renders `<PageContainer><AnalyticsHub …/></PageContainer>`.
A `bare` spec concatenates header + body with no layout chrome, so the frame
must reproduce the `PageContainer` shell exactly — outer scroll div,
`FadeInBody`, and the centered max-width container:

```tsx
import { PageContainer } from '../../app/(app)/../components/page-layout'
```

(actual import path from `web/components/viewspec/blocks.tsx`:
`../page-layout`)

```tsx
'page-container': (({ children }) => (
  <PageContainer>{children}</PageContainer>
)) as FrameComponent,
```

Byte-equivalence note: `PageContainer` takes no other props on this page
(`className` unset), so the frame needs no props. `FadeInBody`'s motion div
(`data-page-motion`, `h-full` + container classes) renders identically in
both paths because it is the same component — the harness compares after the
mount fade settles, same as every other page.

## 2. `WIDGET_REGISTRY` entry (coordinator adds)

```tsx
import { AnalyticsHub } from '../../app/(app)/analytics/AnalyticsHub'

/* --- analytics hub -------------------------------------------------------- */
'analytics-hub': (props) => (
  <AnalyticsHub
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    groups={(props.groups as ComponentProps<typeof AnalyticsHub>['groups']) ?? []}
  />
),
```

Same-component/same-contract notes (per the registry-honesty rule — this is
the one new component, and there is exactly one of it):

- `AnalyticsHub` IS the native hub: the native page renders
  `<AnalyticsHub title description groups>` with the loader-resolved strings
  the spec passes through. There is no second copy — `analytics/` holds no
  `sections.tsx` because there is nothing to extract: the whole page body is
  this one client component (live search filter, icon map, accent map), and
  splitting any of that out would reimplement it badly.
- `groups` travels as plain data (key/label/accent/cards with
  href/title/desc/icon/planned) — no Authz, no org id, no actions. The two
  feature-gated cards (`trueCost` behind `projects`, `utilization` behind
  `timeTracking`) are resolved in the loader by presence (spread or omit),
  exactly as the native page does, so the spec carries no conditional.
- The hub's remaining copy (`searchPlaceholder`, `noMatches`, `planned`)
  stays inside the component via its own `useTranslations('analytics.hub')`,
  identical in both paths.
- All loader message keys already exist: verified against
  `web/messages/en/analytics.json` (`hub.title/description`,
  `hub.groups.*`, `hub.cards.*Title/Desc`).

## 3. Proposed conformance registry entry

Verified against `openbooks_sim_viewspec` (bypass RLS). The harness user
`viewspec@sim.test` holds the Administrator role in org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` (SIM · Summit Ridge Construction),
which passes the page's gate (`reports.read` present). Org features:
`projects: true`, `timeTracking: true` — all 8 cards render, none planned,
so every card is a link.

```js
{
  path: '/analytics',
  variants: [''],
  // Four group sections, eight card links — proves the hub composition
  // rendered, not just the shell. All cards are unplanned in every feature
  // combination the loader can produce for this tenant (planned is never
  // set), so every card renders as a link.
  expect: 'section a[href^="/analytics/"]',
  minMatches: 8,
},
```

- `8` is the exact card count for this tenant (2 per group × 4 groups),
  not a loose lower bound, and the simulator seeds these features
  deterministically. If a future fixture turns a feature off, the count
  drops to 7 (one gated card per flag) — `minMatches: 8` would then fail
  loudly rather than silently pass, which is the point.
- No query variants: the page takes no search params (none read, none
  reflected) and has no drawer/flyout/pager/sort. The client search box
  filters in-browser and is not a route variant.
- No fixture SQL: the page renders zero database rows — its only inputs are
  the permission gate and two feature flags, both satisfied by the harness
  tenant as-is. No allocation-block claim needed.

## 4. What could not be expressed

Nothing. The whole page is one frame plus one widget. No new ViewSpec
vocabulary proposed.
