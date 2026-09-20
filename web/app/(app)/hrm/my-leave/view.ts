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
import { loadMyLeave, type MyLeaveData } from '../../../../lib/hrm/leave'

/**
 * My leave — the employee self-service inbox. Own requests and balances
 * only: the loader scopes every row to the employments behind the login, so
 * there is no employment parameter to forge. Filing opens the same
 * LeaveDrawer; detail reads the self-service path. Renders only when the
 * hrm feature gate is on and the actor holds hrm.leave.request — the view
 * 404s otherwise.
 */

const f = ref<MyLeaveData>()

export function myLeaveSpec(data: MyLeaveData): PageSpec {
  return page({
    route: '/hrm/my-leave',
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
          panel({
            title: f('balancesTitle'),
            iconKey: 'gauge',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              widgetBlock('hrm-leave-balances', {
                balances: data.balances,
                timeKindLabel: data.timeKindLabel,
                valueKindLabel: data.valueKindLabel,
                unlimitedLabel: data.unlimitedLabel,
                empty: data.balancesEmpty,
              }),
            ],
          }),
          panel({
            title: f('title'),
            iconKey: 'calendar',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-0 flex-1',
            blocks: [
              widgetBlock('hrm-leave-queue', {
                rows: data.requests,
                columns: {
                  employee: data.columns.employee,
                  type: data.columns.type,
                  range: data.columns.range,
                  hours: data.columns.hours,
                },
                canFile: true,
                canRecord: false,
                fileTitle: data.fileTitle,
                fileButton: data.fileButton,
                recordTitle: '',
                recordButton: '',
                emptyTitle: data.emptyTitle,
                emptyDescription: data.emptyDescription,
                truncated: false,
                truncatedNote: '',
                notAvailable: data.queue.notAvailable,
                openEmployee: data.queue.openEmployee,
              }),
            ],
          }),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMyLeavePage(): Promise<MyLeaveData> {
  // Self-service gate: hrm.leave.request. Managers land on /hrm/leave; this
  // page never lists another worker's rows.
  const authz = await requirePermission('hrm.leave.request')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadMyLeave(authz)
}

export async function myLeaveTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('myLeave.title')
}
