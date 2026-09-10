# Forecasts (`/crm/forecasts`) — ViewSpec integration handoff

Loader + spec: `view.ts` (`loadForecasts` / `forecastsSpec`).
Shared components: `sections.tsx` (also imported by `page.tsx`, single implementation).

## WIDGET_REGISTRY entries needed (coordinator: `web/components/viewspec/widgets.tsx`)

Imports:

```tsx
import { Gauge, History, Camera, Settings2 } from 'lucide-react'
import { Badge, Button } from '@openbooks/ui'
import { KpiStrip } from '../../../components/kpi-strip'
import { DateRangeFilter } from '../../../components/date-range-filter'
import { ForecastSnapshotButton } from '../../app/(app)/crm/ForecastSnapshotButton'
import {
  ForecastSection,
  ForecastSectionHeading,
  ForecastKpiGroup,
  ForecastFilters,
  ManageQuotasButton,
  QuotaEmptyAction,
  ForecastSnapshotAction,
} from '../../app/(app)/crm/forecasts/sections'
```

Entries:

```tsx
'forecast-snapshot-button': (props) => (
  <ForecastSnapshotAction
    periodStart={str(props, 'periodStart') ?? ''}
    periodEnd={str(props, 'periodEnd') ?? ''}
    ownerUserId={(props.ownerUserId as string | null) ?? null}
    salesTeamId={(props.salesTeamId as string | null) ?? null}
  />
),
'manage-quotas-button': (props) => {
  const href = str(props, 'href')
  if (!href) return null
  return (
    <ManageQuotasButton
      href={href}
      label={str(props, 'label') ?? ''}
      ariaLabel={str(props, 'ariaLabel') ?? ''}
    />
  )
},
// The empty-quota CTA is the solid small Button variant (not `link-button`,
// which is the default-size Button with no size prop).
'quota-empty-action': (props) => (
  <QuotaEmptyAction
    href={str(props, 'href') ?? ''}
    label={str(props, 'label') ?? ''}
    size={str(props, 'size') ?? 'sm'}
  />
),
'date-range-filter': (props) => (
  <DateRangeFilter
    fromKey={str(props, 'fromKey') ?? 'from'}
    toKey={str(props, 'toKey') ?? 'to'}
    fromLabel={str(props, 'fromLabel') ?? ''}
    toLabel={str(props, 'toLabel') ?? ''}
    defaultFrom={str(props, 'defaultFrom')}
    defaultTo={str(props, 'defaultTo')}
    clearable={props.clearable !== false}
  />
),
// NOTE: `search-select-filter` already exists in the registry but drops the
// `className` prop the native page passes (`w-full sm:w-48`). It must forward
// it: `className={str(props, 'className')}`.
'forecast-filters': (props) => (
  <ForecastFilters
    fromKey={str(props, 'fromKey') ?? 'from'}
    toKey={str(props, 'toKey') ?? 'to'}
    fromLabel={str(props, 'fromLabel') ?? ''}
    toLabel={str(props, 'toLabel') ?? ''}
    defaultFrom={str(props, 'defaultFrom') ?? ''}
    defaultTo={str(props, 'defaultTo') ?? ''}
    ownerLabel={str(props, 'ownerLabel') ?? ''}
    ownerOptions={(props.ownerOptions as ComponentProps<typeof ForecastFilters>['ownerOptions']) ?? []}
    teamLabel={str(props, 'teamLabel') ?? ''}
    teamOptions={(props.teamOptions as ComponentProps<typeof ForecastFilters>['teamOptions']) ?? []}
  />
),
'forecast-kpi-group': (props) => (
  <ForecastKpiGroup
    currency={str(props, 'currency') ?? ''}
    items={(props.items as ComponentProps<typeof ForecastKpiGroup>['items']) ?? []}
  />
),
'section-heading': (props) => {
  const icons: Record<string, ReactNode> = {
    gauge: <Gauge size={17} />,
    history: <History size={17} />,
  }
  const iconKey = str(props, 'iconKey')
  return (
    <ForecastSectionHeading
      id={str(props, 'id') ?? ''}
      icon={iconKey ? icons[iconKey] : undefined}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description')}
    />
  )
},
```

The quota `EmptyState` action names `quota-empty-action` with
`actionProps: { href, label, size: 'sm' }` — the native empty-state CTA is a
solid small `Button`, which the stock `link-button` widget (default size, no
size prop) does not render.

The history `EmptyState` action names `forecast-snapshot-button` (falsy when
the reader lacks `crm.forecasts.manage`, so the widget renders nothing —
same as the native `snapshotAction ?? undefined`).

The header `manage-quotas-button` delegates to `ManageQuotasButton`, which
renders the native chrome exactly (`outline`/`sm` asChild, `Settings2` at
size 15, `hidden sm:inline` label span, `aria-label`).

## Frame registry entry needed (coordinator: `web/components/viewspec/blocks.tsx`)

```tsx
import {
  ForecastSection,
  // ...
} from '../../app/(app)/crm/forecasts/sections'

const FRAME_REGISTRY: Record<string, FrameComponent> = {
  // ...existing entries...
  'forecast-section': (({ labelledBy, children }) => (
    <ForecastSection labelledBy={labelledBy as string}>{children}</ForecastSection>
  )) as unknown as FrameComponent,
}
```

The spec calls `frame('forecast-section', [...], { labelledBy: '<heading-id>' })`
once per section.

## Empty-state icons

The spec passes `icon: 'gauge'` (summary + quotas) and `icon: 'camera'`
(history) to the `empty-state` widget. The registry's icon map needs both:

```tsx
gauge: <Gauge />,
camera: <Camera />,
```

(`Gauge`/`Camera` join the existing lucide imports in `widgets.tsx`.)

## Proposed conformance entry (coordinator: `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/crm/forecasts',
  // Three sections with independent presence flags: KPI groups per currency,
  // the quota table, and the snapshot history. Fixtures in
  // scripts/viewspec-fixtures.sql seed two open opportunities, one quota and
  // one snapshot for the harness user so all three bodies render.
  variants: [
    '',
    // Owner filter: exercises the exclusive owner/team branch.
    '?owner=68998480-15db-4f5d-bf0b-9e1ef472b0d7',
    // Deliberate empty result: asserts the empty branches, not row content.
    '?owner=00000000-0000-0000-0000-000000000000',
  ],
  expect: 'section table tbody tr',
  minMatches: 2,
},
```

Verified against the database (read-only):

- `crm_opportunities` active: 2 (both `owner 68998480…`, close dates within
  the current quarter, `most_likely`/`upside`)
- `crm_sales_quotas`: 1 overlapping the default period
- `crm_forecast_snapshots`: 1 for the default period
- `users` active: 5 (owner filter options); `crm_sales_teams` active: 0

`expect`/`minMatches` are NOT yet verified against a running render — no
server was started per the brief. The quota table (1 row) plus the history
table (1 row) give at least 2 `tbody tr` matches on the default variant; the
owner variant keeps both rows; the zero-uuid owner variant renders all three
empty states. The coordinator should confirm the selector against the live
harness.

## Anything I could not express

1. **`search-select-filter` drops `className`.** The existing registry entry
   does not forward `className`, but the native filters pass
   `w-full sm:w-48`. Without the fix the spec render loses responsive sizing
   on both selects. One-line coordinator fix noted above.
2. **No `date-range-filter` widget exists.** Proposed above; props mirror the
   component exactly (`fromKey`/`toKey`/`fromLabel`/`toLabel`/`defaultFrom`/
   `defaultTo`/`clearable`). Alternatively the coordinator may prefer the
   single `forecast-filters` widget (also proposed), which places all three
   filters in one `flex flex-wrap items-center gap-2` div — byte-identical to
   the native row. The spec currently uses the three separate widgets; switch
   to `forecast-filters` if the coordinator prefers one entry over three.
   (If the coordinator picks `forecast-filters`, `ManageQuotasButton`'s icon
   and span stay in `sections.tsx` regardless — the header buttons are
   separate widgets either way.)
3. **`frame` props are literals.** The `labelledBy` values are static strings
   baked at spec-build time, matching how `tab-content` receives `tabKey`
   from loader data. No new vocabulary needed.
4. **Snapshot override `money` cell on an em-dash.** When `override_amount`
   is null the native renders a bare `—` inside the right-aligned `<td>`. The
   loader pre-resolves `'—'` into the field so the cell is `money(...)` either
   way; the rendered string is identical.
5. **No new ViewSpec vocabulary needed.** `frame`, `repeat` + `unwrapped`,
   `text` cell `className`, and the `empty-state` `action`/`actionProps` slot
   cover everything. The one judgment call: `forecast-section` as a frame
   rather than a `grid as: 'section'` — the aria-labelledby/id pairing and
   the icon heading are component chrome, not layout, and a grid cannot carry
   either.
