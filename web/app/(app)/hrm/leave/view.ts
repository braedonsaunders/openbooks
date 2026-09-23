import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  link,
  page,
  pageHeader,
  ref,
  spanRow,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadLeaveQueue, type LeaveQueueData } from '../../../../lib/hrm/leave'

/**
 * The org-wide leave queue, split into a loader and a spec.
 *
 * Follows the close-list archetype: the rows render through the shared
 * `table` block (variant 'app') over loader-resolved display cells, segments
 * ride the shared `list-toolbar` on the `segment` search param (pending
 * approval, upcoming, on leave today, history), and "File leave request"
 * plus "Record absence" are page-header primary actions opening a URL-param
 * dialog. The list itself is loader-resolved through the leave read service,
 * newest start first, with subsidiary scope enforced inside it.
 *
 * Requests and the department calendar are TABS on the shared subtab strip
 * (`?view=`), not two panels down one page. Stacked, the calendar lived
 * under a table sized to fill the viewport — so it was below the fold on
 * every screen, and the page read as a list with something unexplained
 * bolted to the bottom.
 */

const f = ref<LeaveQueueData>()

// The registry builds every spec from its data alone (scripts/page-registry-source.mjs),
// so the base path defaults to the literal route the spec declares.
export function leaveQueueSpec(data: LeaveQueueData, basePath: string = '/hrm/leave'): PageSpec {
  return page({
    route: '/hrm/leave',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget(
            'link-button',
            { href: f('fileHref'), label: f('fileButton'), iconKey: 'plus' },
            f('canFile'),
          ),
          widget(
            'link-button',
            { href: f('recordHref'), label: f('recordButton'), iconKey: 'plus', variant: 'outline' },
            f('canRecord'),
          ),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
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
          // The view switch and the segment filter share one row: the shared
          // subtab strip on the left, the shared toolbar on the right.
          grid('flex shrink-0 flex-wrap items-center gap-3', [
            widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
            {
              ...widgetBlock('list-toolbar', {
                basePath,
                currentParams: data.currentParams,
                filters: [
                  {
                    paramKey: 'segment',
                    label: data.segmentsLabel,
                    allLabel: data.allLabel,
                    options: data.segments,
                  },
                ],
              }),
              when: f('onRequests'),
            },
            // The calendar's own controls, on the SAME toolbar: department
            // picks the roster, from/to the window.
            {
              ...widgetBlock('list-toolbar', {
                basePath,
                currentParams: data.currentParams,
                filters: [
                  {
                    paramKey: 'department',
                    label: data.calendarDepartmentLabel,
                    allLabel: data.queue.notAvailable,
                    options: data.departmentOptions,
                  },
                ],
              }),
              when: f('onCalendar'),
            },
            {
              ...widgetBlock('date-range-filter', {
                fromLabel: data.calendarFromLabel,
                toLabel: data.calendarToLabel,
                clearLabel: data.allLabel,
              }),
              when: f('onCalendar'),
            },
          ]),
          // No panel around either surface: the active tab already names it,
          // and a card headed "Leave requests" under a tab reading "Leave
          // requests" is the same words twice with a border between them.
          {
            ...grid('flex min-h-0 flex-1 flex-col gap-4', [
              table({
                variant: 'app',
                rows: f('rows'),
                rowKey: item('id'),
                columns: [
                  column(f('columns.employee'), link(item('employeeLabel'), item('employeeHref'))),
                  column(f('columns.type'), text(item('leaveTypeCode'))),
                  column(
                    f('columns.range'),
                    text(item('rangeLabel'), { className: 'tabular-nums' }),
                  ),
                  column(f('columns.hours'), text(item('hours')), {
                    align: 'right',
                    className: 'tabular-nums',
                  }),
                  column(f('columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
                  column('', link(item('openLabel'), item('requestHref'))),
                ],
                empty: { title: f('emptyTitle'), description: f('emptyDescription') },
                ...(data.truncated
                  ? {
                      trailing: [
                        spanRow({
                          label: f('truncatedNote'),
                          labelColSpan: 6,
                          labelClassName:
                            'text-center text-xs text-slate-400 dark:text-slate-500',
                          cells: [],
                        }),
                      ],
                    }
                  : {}),
              }),
              widgetBlock(
                'hrm-leave-dialog',
                {
                  requestId: f('dialogRequestId'),
                  closeHref: f('dialogCloseHref'),
                },
                f('dialogOpen'),
              ),
            ]),
            when: f('onRequests'),
          },
          {
            ...widgetBlock('hrm-leave-calendar', {
              days: data.calendarDays,
              empty: data.calendarEmpty,
            }),
            when: f('onCalendar'),
          },
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
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadLeaveQueue(authz, sp)
}

export async function leaveQueueTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('leave.title')
}
