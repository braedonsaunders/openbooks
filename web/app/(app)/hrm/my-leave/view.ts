import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  link,
  page,
  pageHeader,
  panel,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadMyLeave, type MyLeaveData } from '../../../../lib/hrm/leave'
import { meTabs } from '../../../../lib/hrm/self-service'

/**
 * My leave — the employee self-service inbox. Own requests and balances
 * only: the loader scopes every row to the employments behind the login, so
 * there is no employment parameter to forge. The requests render through the
 * shared `table` block over loader-resolved display cells exactly like the
 * org queue; filing opens the same LeaveDrawer through the `file` search
 * param. Balances stay a component (a labelled list, not a table). Renders
 * only when the hrm feature gate is on and the actor holds
 * hrm.leave.request — the view 404s otherwise.
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
        actions: [
          widget('link-button', { href: f('fileHref'), label: f('fileButton'), iconKey: 'plus' }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
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
              table({
                variant: 'app',
                rows: f('requests'),
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
                  column(
                    f('columns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column('', link(item('openLabel'), item('requestHref'))),
                ],
                empty: { title: f('emptyTitle'), description: f('emptyDescription') },
              }),
              widgetBlock(
                'hrm-leave-dialog',
                {
                  requestId: f('dialogRequestId'),
                  closeHref: f('dialogCloseHref'),
                },
                f('dialogOpen'),
              ),
            ],
          }),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMyLeavePage(
  sp: Record<string, string | undefined> = {},
): Promise<MyLeaveData> {
  // Self-service gate: hrm.leave.request. Managers land on /hrm/leave; this
  // page never lists another worker's rows.
  const authz = await requirePermission('hrm.leave.request')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  const data = await loadMyLeave(authz, sp)
  return { ...data, tabs: await meTabs(authz, '/hrm/my-leave') }
}

export async function myLeaveTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('myLeave.title')
}
