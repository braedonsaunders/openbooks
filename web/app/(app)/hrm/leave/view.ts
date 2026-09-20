import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadLeaveQueue, type LeaveQueueData } from '../../../../lib/hrm/leave'

/**
 * The org-wide leave queue, split into a loader and a spec.
 *
 * Follows the change-request-queue archetype: ViewSpec composes the grid
 * and the panels; the queue body stays a component shared by the page and
 * the widget registry via ./LeaveQueue so they cannot drift. Segments ride
 * the shared `filter-chips` widget on the `segment` search param
 * (pending approval, upcoming, on leave today, history); the list itself is
 * loader-resolved through the leave read service, newest start first, with
 * subsidiary scope enforced inside it. The department calendar reads
 * through the attendance service on the department/from/to params.
 */

const f = ref<LeaveQueueData>()

export function leaveQueueSpec(data: LeaveQueueData, basePath: string): PageSpec {
  return page({
    route: '/hrm/leave',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      // A computed refusal (unknown segment, scope denial) renders with its
      // message intact — never a success, never an empty table.
      widgetBlock(
        'empty-state',
        {
          title: data.refusal?.title ?? '',
          description: data.refusal?.message,
        },
        f('refusal'),
      ),
      {
        ...grid('flex h-full min-h-0 flex-col gap-4', [
          widgetBlock('filter-chips', {
            basePath,
            currentParams: data.currentParams,
            paramKey: 'segment',
            label: data.segmentsLabel,
            allLabel: data.allLabel,
            options: data.segments,
          }),
          panel({
            title: f('listTitle'),
            iconKey: 'calendar',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-0 flex-1',
            blocks: [
              widgetBlock('hrm-leave-queue', {
                rows: data.rows,
                columns: data.columns,
                canFile: data.canFile,
                canRecord: data.canRecord,
                fileTitle: data.fileTitle,
                fileButton: data.fileButton,
                recordTitle: data.recordTitle,
                recordButton: data.recordButton,
                emptyTitle: data.emptyTitle,
                emptyDescription: data.emptyDescription,
                truncated: data.truncated,
                truncatedNote: data.truncatedNote,
                notAvailable: data.queue.notAvailable,
                openEmployee: data.queue.openEmployee,
              }),
            ],
          }),
          panel({
            title: f('calendarTitle'),
            iconKey: 'calendar',
            bodyClassName: 'p-4',
            blocks: [
              widgetBlock('hrm-leave-calendar', {
                basePath,
                currentParams: data.currentParams,
                departmentOptions: data.departmentOptions,
                departmentLabel: data.calendarDepartmentLabel,
                fromLabel: data.calendarFromLabel,
                toLabel: data.calendarToLabel,
                showLabel: data.calendarShowLabel,
                days: data.calendarDays,
                empty: data.calendarEmpty,
                notAvailable: data.queue.notAvailable,
              }),
            ],
          }),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadLeaveQueuePage(
  sp: Record<string, string | undefined>,
): Promise<LeaveQueueData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.leave.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadLeaveQueue(authz, sp)
}

export async function leaveQueueTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('leave.title')
}
