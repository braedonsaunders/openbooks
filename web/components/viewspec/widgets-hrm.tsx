import type { ComponentProps } from 'react'
import { HrmPendingRequests, HrmReadiness, HrmRecentChanges, HrmUpcomingChanges } from '../../app/(app)/hrm/sections'
import { PositionDrawer, PositionSegments, PositionsTable, VacancyTable } from '../../app/(app)/hrm/positions/sections'
import { ChangeRequestQueue } from '../../app/(app)/hrm/change-requests/QueueClient'
import { str, type WidgetRenderer } from './widget-props'

/** HR workspace adapters; lifecycle permissions remain owned by the rendered components. */
export const HRM_WIDGETS = {
  'hrm-change-request-queue': (props) => (
    <ChangeRequestQueue
      rows={(props.rows as ComponentProps<typeof ChangeRequestQueue>['rows']) ?? []}
      columns={props.columns as ComponentProps<typeof ChangeRequestQueue>['columns']}
      canManage={props.canManage === true}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof ChangeRequestQueue>['departmentOptions']) ?? []}
      proposeTitle={str(props, 'proposeTitle') ?? ''}
      proposeButton={str(props, 'proposeButton') ?? ''}
      proposeEmploymentLabel={str(props, 'proposeEmploymentLabel') ?? ''}
      proposeEmploymentPlaceholder={str(props, 'proposeEmploymentPlaceholder') ?? ''}
      proposeEmpty={str(props, 'proposeEmpty') ?? ''}
      proposeFailed={str(props, 'proposeFailed') ?? ''}
      draftBadge={str(props, 'draftBadge') ?? ''}
      openEmployee={str(props, 'openEmployee') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
      emptyTitle={str(props, 'emptyTitle') ?? ''}
      emptyDescription={str(props, 'emptyDescription') ?? ''}
      truncated={props.truncated === true}
      truncatedNote={str(props, 'truncatedNote') ?? ''}
    />
  ),
  'hrm-pending-requests': (props) => (
    <HrmPendingRequests
      items={(props.items as ComponentProps<typeof HrmPendingRequests>['items']) ?? []}
      empty={str(props, 'empty') ?? ''}
      viewAllHref={str(props, 'viewAllHref') ?? ''}
      viewAllLabel={str(props, 'viewAllLabel') ?? ''}
      refusal={str(props, 'refusal') ?? null}
      notAvailable={str(props, 'notAvailable') ?? ''}
    />
  ),
  'hrm-readiness': (props) => (
    <HrmReadiness
      message={str(props, 'message') ?? ''}
      docHref={str(props, 'docHref') ?? ''}
      docLabel={str(props, 'docLabel') ?? ''}
      tone={props.tone === 'warning' ? 'warning' : 'positive'}
    />
  ),
  'hrm-recent-changes': (props) => (
    <HrmRecentChanges
      items={(props.items as ComponentProps<typeof HrmRecentChanges>['items']) ?? []}
      empty={str(props, 'empty') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
    />
  ),
  'hrm-upcoming-changes': (props) => (
    <HrmUpcomingChanges
      starts={(props.starts as ComponentProps<typeof HrmUpcomingChanges>['starts']) ?? []}
      ends={(props.ends as ComponentProps<typeof HrmUpcomingChanges>['ends']) ?? []}
      startsTitle={str(props, 'startsTitle') ?? ''}
      startsEmpty={str(props, 'startsEmpty') ?? ''}
      endsTitle={str(props, 'endsTitle') ?? ''}
      endsEmpty={str(props, 'endsEmpty') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
      truncated={props.truncated === true}
      truncatedNote={str(props, 'truncatedNote') ?? ''}
    />
  ),
  /** Status segments: server-side filter pills with per-status counts over
   *  loader-computed hrefs. A widget, not `filter-chips`: the hrefs carry the
   *  effective date as well as the status, so they are resolved in the loader
   *  and passed whole rather than rebuilt from a param key. */
  'hrm-position-segments': (props) => (
    <PositionSegments
      ariaLabel={str(props, 'ariaLabel') ?? ''}
      segments={(props.segments as ComponentProps<typeof PositionSegments>['segments']) ?? []}
    />
  ),
  /** The funded-establishment vacancy table over loader-resolved rows plus
   *  loader-resolved strings — the same PositionsTable the native page
   *  renders, so the two cannot drift. */
  'hrm-positions-table': (props) => (
    <PositionsTable
      columns={(props.columns as ComponentProps<typeof PositionsTable>['columns']) ?? {}}
      rows={(props.rows as ComponentProps<typeof PositionsTable>['rows']) ?? []}
      empty={str(props, 'empty') ?? ''}
      totals={(props.totals as ComponentProps<typeof PositionsTable>['totals']) ?? { plannedFte: '0', fundedFte: '0', filledFte: '0', vacantFte: '0' }}
      totalLabel={str(props, 'totalLabel') ?? ''}
    />
  ),
  /** The position flyout: a URL drawer around the shared PositionDrawerBody
   *  that closes by navigation. Null payload renders nothing — the spec's
   *  `when` gate already omits it, so this is the second half of the same
   *  guard. */
  'hrm-position-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof PositionDrawer>['drawer']
    if (!drawer) return null
    return <PositionDrawer drawer={drawer} />
  },
  /** A widget, not a slot: the loader already resolved vacancy through the
   *  canonical position read service and passes rows plus loader-resolved
   *  strings as data, so no org id, user id or Authz crosses the spec. */
  'hrm-vacancy-table': (props) => (
    <VacancyTable
      groups={(props.groups as ComponentProps<typeof VacancyTable>['groups']) ?? []}
      total={(props.total as ComponentProps<typeof VacancyTable>['total']) ?? { positions: 0, plannedFte: '0.0000', fundedFte: '0.0000', filledFte: '0.0000', vacantFte: '0.0000' }}
      departmentColumn={str(props, 'departmentColumn') ?? ''}
      employerColumn={str(props, 'employerColumn') ?? ''}
      positionsColumn={str(props, 'positionsColumn') ?? ''}
      plannedColumn={str(props, 'plannedColumn') ?? ''}
      fundedColumn={str(props, 'fundedColumn') ?? ''}
      filledColumn={str(props, 'filledColumn') ?? ''}
      vacantColumn={str(props, 'vacantColumn') ?? ''}
      empty={str(props, 'empty') ?? ''}
      totalLabel={str(props, 'totalLabel') ?? ''}
    />
  ),

} satisfies Record<string, WidgetRenderer>
