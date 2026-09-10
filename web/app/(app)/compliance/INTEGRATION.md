# /compliance ViewSpec integration handoff

Page: `/compliance` — the subcontractor compliance cockpit (four stat tiles,
four panels, setup banner, bottom empty state). Follows the purchasing-cockpit
precedent: ViewSpec composes the grid and the panels; panel bodies stay
components in `./sections`, shared by both render paths.

Files created/edited (all inside `web/app/(app)/compliance/`, the only dir
this page owns):

- `view.ts` — `loadCompliance(sp)` + `complianceSpec(data)`. The loader copies
  the native page's permission gates (`compliance.read`, compliance feature
  gate), the 1099-year defaulting, and the overview query verbatim; money via
  the same `getMoneyFormatter`, tones/accents via the same ternaries, labels
  via the same `compliance` message keys. Four presence flags choose the
  page's independent regions (`showSetupBanner`, `showWaivers`, `showEmpty`;
  blocked/expiring/readiness panels always render, owning their own empty
  state inside the section component).
- `sections.tsx` — `BlockedBillsSection`, `ExpiringVendorsSection`,
  `OutstandingWaiversSection`, `ReadinessQueueSection` (each including its
  empty `<p>`, the purchasing `CommitmentsSection` idiom), plus
  `ComplianceSetupBanner` (a plain Alert, NOT the dashed-card EmptyState),
  `WaiversPanel` and `ReadinessPanel` (full `HomePanel`s with header actions —
  `panel` blocks carry no `actions` slot, and actions are JSX a spec cannot
  express). The native `page.tsx` imports all of these back, so both paths
  share one implementation.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged apart from rendering the shared section components.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import {
  BlockedBillsSection,
  ComplianceSetupBanner,
  ExpiringVendorsSection,
  ReadinessPanel,
  WaiversPanel,
} from '../../app/(app)/compliance/sections'

/* --- compliance cockpit ------------------------------------------------- */
'compliance-setup-banner': (props) => (
  <ComplianceSetupBanner
    prompt={str(props, 'prompt') ?? ''}
    actionHref={str(props, 'actionHref') ?? ''}
    actionLabel={str(props, 'actionLabel') ?? ''}
  />
),
'blocked-bills': (props) => (
  <BlockedBillsSection
    rows={props.rows as ComponentProps<typeof BlockedBillsSection>['rows']}
    empty={str(props, 'empty') ?? ''}
  />
),
'expiring-vendors': (props) => (
  <ExpiringVendorsSection
    rows={props.rows as ComponentProps<typeof ExpiringVendorsSection>['rows']}
    empty={str(props, 'empty') ?? ''}
  />
),
'waivers-panel': (props) => (
  <WaiversPanel
    title={str(props, 'title') ?? ''}
    hint={str(props, 'hint') ?? ''}
    actionHref={str(props, 'actionHref') ?? ''}
    actionLabel={str(props, 'actionLabel') ?? ''}
    rows={props.rows as ComponentProps<typeof WaiversPanel>['rows']}
    empty={str(props, 'empty') ?? ''}
  />
),
'readiness-panel': (props) => (
  <ReadinessPanel
    title={str(props, 'title') ?? ''}
    hint={str(props, 'hint') ?? ''}
    actionHref={str(props, 'actionHref') ?? ''}
    actionLabel={str(props, 'actionLabel') ?? ''}
    rows={props.rows as ComponentProps<typeof ReadinessPanel>['rows']}
    empty={str(props, 'empty') ?? ''}
  />
),
```

`'module-home-tabs'` and `'empty-state'` already exist and need no change.
No new slot is needed: the page is read-only and takes no drawer, no
`Authz`, no org id — the loader re-derives everything from the session via
`requirePermission`, exactly as the native page does.

Note on `stateTone`: the loader passes its return value straight through as
`stateVariant`, and the section renders `<Badge variant={...}>`. `stateTone`
returns `'success'` for compliant, which the native `Badge` also accepts
(green ramp) — the spec path and the native path render the same component
with the same value, so there is no divergence to reconcile.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, `subcontractorCompliance` and
`projects` both on):

- `compliance_requirements` in harness org: **2** (GL `block_payment`, WC
  `warn`), both class-agnostic; `compliance_classes`: **1** →
  `configured` is true, so the setup banner is absent on the default render.
- 12 classified vendors × 2 class-agnostic policies with **0**
  `compliance_records` → every finding is `missing` (a failing state), so all
  12 vendors are blocked; `blockedVendors` = 12, exposure tile amber/warning.
- Candidate `main section li` rows: ≤12 blocked bills + ≤12 expiring (0 —
  nothing is `expiring`) + ≤12 waivers (1: `LW-0002` requested) + ≤12
  readiness. minMatches 4 is safe (12 tracked vendors guarantee the blocked
  panel alone exceeds it), and it also passes if the harness tenant's
  business-today/readiness mix shifts rows between panels.
- `?year=<defaultTaxYear>` variant pins the readiness panel title's
  `{ year: taxYear }` interpolation to a deterministic string.

```js
{
  path: '/compliance',
  // Cockpit: stat tiles plus four panel lists. The sim org has 12 tracked
  // vendors and no evidence, so the blocked panel is full; the year variant
  // pins the readiness title's interpolated tax year.
  variants: ['', '?year=2025'],
  expect: 'main section li',
  minMatches: 4,
},
```

No fixture SQL: the sim org already exercises every region (blocked bills,
outstanding waiver `LW-0002`, readiness queue, configured banner-off). The
`showEmpty` bottom state (configured + zero filings + zero tracked) cannot
occur in the harness tenant and is not covered — same accepted gap as the
assets page's drawer variant.

## What could not be expressed

Two `HomePanel` header actions (waivers, readiness) and the Alert-shaped
setup banner are full components in `./sections`, not `panel`/`text` blocks:
`panel` carries no `actions` slot, and the shared `empty-state` widget
renders the dashed-card `EmptyState`, not an Alert. The division is the one
the purchasing cockpit established — ViewSpec composes panels and grid;
one-off bodies stay components — and both render paths share them.
