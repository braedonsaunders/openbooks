# /reports ViewSpec integration handoff

Page: `web/app/(app)/reports/` — owner files are `view.ts` (+ this file)
and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`:
there is exactly one `ReportsHub` and it is reused whole (see below).

Spec blocks used: one `frame` + one widget. No new vocabulary beyond the
two registry additions proposed below.

## 1. WIDGET_REGISTRY + frame entries (for the coordinator)

`ReportsHub` is a client component (`'use client'` — search state) that
owns the hub header, the group/card markup and the New-report create flow.
It is NOT decomposed: decomposing it would reimplement its icons, accents
and search filtering in a second component behind the same name — the
failure mode flagged last round. The registry entries reuse the one
existing component:

```tsx
import { PageContainer } from '../page-layout'
import { ReportsHub } from '../../app/(app)/reports/ReportsHub'
```

Frame (place beside `tab-content` in `FRAME_REGISTRY`,
`web/components/viewspec/blocks.tsx`):

```tsx
'page-container': ((props: Record<string, unknown> & { children: ReactNode }) => (
  <PageContainer>{props.children}</PageContainer>
)) as FrameComponent,
```

Why a frame and not spec grids: `PageContainer` wraps its children in a
`FadeInBody` motion wrapper (`framer-motion`, `data-page-motion`,
opacity/y animation with `useReducedMotion`). A motion component cannot
travel through spec props, and re-expressing the shell as plain grids
would drop the fade-in the native page renders. The frame names the exact
component (`ForecastSection` is imported in `blocks.tsx` from its app path
today, so the coordinator can mirror that line).

Widget:

```tsx
/**
 * The reports hub content: bespoke h1 header, client-side search filter,
 * permission/feature-gated group cards, and the New-report create button.
 * One component, shared by both render paths — never a second copy.
 */
'reports-hub': (props) => (
  <ReportsHub
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    groups={(props.groups as ComponentProps<typeof ReportsHub>['groups']) ?? []}
    canCreate={props.canCreate === true}
  />
),
```

Why one widget and not grid/heading/repeat + card widgets: the cards sit
behind client-side search state (`useState` + `useMemo` filter with its own
empty state). A spec-side repeat would render the unfiltered groups while
the search input — also client state — lives elsewhere; the two can only
stay consistent inside the one component that owns both. The loader still
does every permission, feature and entity-visibility computation; the
widget only filters already-visible cards by the typed query.

## 2. Slot proposals (none)

No slot is needed. The loader calls `getAuthz`/`hiddenReportEntityKeys`/
`isFeatureEnabled` server-side and ships only data (strings, booleans,
hrefs, translated labels); no Authz, org id or user id crosses the spec.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-…`, harness super-admin `viewspec@sim.test`). Resolved render:

- features projects/orders/budgets OFF (absent from settings, defaults
  false) → their groups absent; payroll ON (stored `true`).
- 15 `report_definitions` match the loader predicate; all entities visible
  (payroll.* gated on `payroll.read` + payroll feature — both pass;
  `lot_movements` on inventory — stored `true`; `ledger_lines` ungated).
- 6 payroll-entity built-ins → `payroll` group; remaining 9 flow into
  `custom` after the project-profitability exclusion (no-op here).
- 0 saved views. `canCreate` true via the `*` wildcard.

Groups: financial (5) + ledger (2) + receivablesPayables (7) + payroll (6)
+ custom (1 studio + 9 definitions) = 5 groups, 30 cards.

```js
{
  path: '/reports',
  // Interactive hub: permission/feature-gated groups, payroll first-class
  // group, custom-definitions tail. The harness tenant renders 5 groups /
  // 30 cards; the New-report button is present (reports.create via `*`).
  variants: [''],
  expect: 'main section',
  minMatches: 5,
},
```

GATES check: no auth gate (logged-out users get `canCreate: false` and
empty queries, still 200 — no redirect, no 404), no row-count gate beyond
the group/card counts above, both verified against the sim tenant. No
query variants exist on this page (the search box is client state, not a
URL param).

## 4. Fixture SQL (none)

No fixtures needed: the sim tenant already satisfies every gate (features,
definitions, super-admin user). No id block is claimed.

## 5. What the spec does NOT cover (nothing — full coverage)

- The `saved_reports`/`report_definitions` queries, the four feature
  probes, `hiddenReportEntityKeys`, the payroll split, the saved-view
  `URLSearchParams` building, and the `canCreate` gate are all loader work
  copied verbatim from `page.tsx`.
- Message keys used by the loader (`hub.*`, `custom.kind.*`,
  `aging.*`, `analytics.trueCost.*`) are all already consumed by the
  native page or present in `web/messages/en/*.json` — verified by grep;
  none invented.
- `page.tsx` native branch is untouched below the `__viewspec` branch.
