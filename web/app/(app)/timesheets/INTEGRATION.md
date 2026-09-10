# INTEGRATION — `/timesheets` ViewSpec handoff

Page: the weekly-timesheet list (entity list over the `timesheet_week`
aggregate + the WeeklyGrid editor flyout). Files owned by this conversion:

- `web/app/(app)/timesheets/view.ts` — `loadTimesheets(sp)` plus
  `timesheetsSpec(data)`.
- `web/app/(app)/timesheets/page.tsx` — `__viewspec=1` branch added
  (native branch untouched). No `sections.tsx`: the page defines no local
  components — the New button is an inline `<Link>` and the grid is the
  shared `WeeklyGrid` — so there is nothing composite to move.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

Import to add (`Link` is already imported in `widgets.tsx` — no import needed
for the button):

```tsx
import { WeeklyGrid } from '../../app/(app)/timesheets/WeeklyGrid'
```

Entries:

```tsx
'new-timesheet': (props) => (
  <Link
    href={str(props, 'href') ?? '/timesheets'}
    className="inline-flex h-8 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white shadow-sm hover:bg-teal-800"
  >
    {str(props, 'label') ?? ''}
  </Link>
),
/** The remount key rides along as a prop: switching employees or weeks must
 *  reset the grid's client state, and a widget at a fixed position would
 *  otherwise be reused. */
'timesheet-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof WeeklyGrid> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <WeeklyGrid key={remountKey} {...rest} />
},
```

Spec-to-widget wiring (already in `timesheetsSpec`, for reference):

- header action: `widget('new-timesheet', data.newButton, f('canManage'))`
  (`WidgetSlot` is a Fragment — a `when`-off widget leaves no wrapper div, so
  the no-permission header matches the native one exactly).
- body: `entity-list-view` with `recordType: 'timesheet_week'`,
  `emptyAction` the same `new-timesheet` ref (when `canManage`), and `drawer`
  a one-entry list with the `timesheet-drawer` ref (or `[]`, which the slot
  resolves to `undefined`).

`entity-list-view` already exists in the registry — no entry needed.

## 2. Proposed conformance entry (`scripts/viewspec-conformance.mjs`)

```js
{
  path: '/timesheets',
  // Entity list over the timesheet_week aggregate plus the WeeklyGrid editor
  // in the drawer slot. SIM holds 168 approved weeks and no weeks of any
  // other status, so the status variant pins `approved` — `submitted` would
  // render the empty branch. The drawer id is a real SIM employee:week.
  variants: [
    '',
    '?status=approved',
    {
      query: '?timesheet=044ea4d1-8157-4cb8-93f9-7b70e7ec8f80:2025-12-28',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 5,
},
```

Verified against the database (`openbooks_sim_viewspec`, RLS bypassed):
168 `timesheet_week` aggregates in the SIM org, all `status = approved`
(729 underlying `time_entries`); first page holds 25 rows, so `minMatches: 5`
is safe for both list variants. The drawer week above is `approved`, which
also exercises the grid's read-only path and its status badge.

No fixture SQL: the sim seed already covers the list, the status filter, and
the drawer branches.

## 3. What could not be expressed (and why)

1. ~~Drawer remount key~~ — solved via the merged vocabulary: the loader puts
   `remountKey: \`${openEmployeeId}:${openWeek}\`` on the drawer props and the
   `timesheet-drawer` entry above strips it into a React key, exactly as
   `party-drawer` / `project-drawer` already do.
2. **Nothing else.** The permission gates (`time.read`, `timeTracking`
   feature), the employee-picker query, the `timesheet=<uuid>:<week>`
   flyout parsing with tenant pinning, the `drawerReturn` close target, the
   time-policy flag, and the line field defs are all reproduced verbatim in
   the loader. The grid's props are checked against `WeeklyGrid` with a
   `satisfies` in `view.ts`, so a prop rename fails in the owned file.
