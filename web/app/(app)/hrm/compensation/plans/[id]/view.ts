import 'server-only'

import { notFound } from 'next/navigation'
import {
  badge,
  column,
  field as item,
  page,
  pageHeader,
  panel,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { compensationAuthz, loadHeadcountPlanDetail, type CompPlanDetailData } from '../../../../../../lib/hrm/compensation'

/**
 * One headcount plan: costed plan lines with the costed total against
 * the position budget, approve opens requisitions. Rows stay
 * loader-resolved; approval rides the per-line island button.
 */

const f = item
const rootF = rootRef<CompPlanDetailData>()

export function compPlanSpec(data: NonNullable<Awaited<ReturnType<typeof loadHeadcountPlanDetail>>>): PageSpec {
  // Managers get the per-line approve button: the island itself renders
  // nothing unless the line is proposed, and the endpoint owns the grant
  // and the transition — readers get no column at all.
  const columns = [
    column(f('columns.title'), text(item('title'))),
    column(f('columns.kind'), badge(item('kindLabel'))),
    column(f('columns.fte'), text(item('fte')), { align: 'right', className: 'tabular-nums' }),
    column(f('columns.start'), text(item('startOn'))),
    column(f('columns.cost'), text(item('cost')), { align: 'right', className: 'tabular-nums' }),
    column(f('columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
  ]
  if (data.canManage) {
    columns.push(
      column(
        f('columns.action'),
        widgetCell('hrm-plan-line-approve', {
          planId: rootF('planId'),
          lineId: item('id'),
          lineStatus: item('status'),
          approve: rootF('lineApprove'),
        }),
      ),
    )
  }
  return page({
    route: '/hrm/compensation/plans/[id]',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('period'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('backHref'), label: f('backLabel'), iconKey: 'arrow-left', variant: 'outline' }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
      panel({
        title: f('linesTitle'),
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        className: 'min-h-0 flex-1',
        blocks: [
          table({
            variant: 'app',
            rows: f('lines'),
            rowKey: item('id'),
            empty: { title: f('linesEmpty') },
            columns,
          }),
        ],
      }),
    ],
  })
}

export async function compPlanTitle(planId: string): Promise<string> {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadHeadcountPlanDetail(authz, planId)
  if (!data) notFound()
  return data.title
}

export async function loadCompPlanPage(planId: string) {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadHeadcountPlanDetail(authz, planId)
  if (!data) notFound()
  return data
}
