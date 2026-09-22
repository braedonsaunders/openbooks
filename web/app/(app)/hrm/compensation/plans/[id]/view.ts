import 'server-only'

import { notFound } from 'next/navigation'
import {
  badge,
  column,
  field as item,
  page,
  pageHeader,
  panel,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { compensationAuthz, loadHeadcountPlanDetail } from '../../../../../../lib/hrm/compensation'

/**
 * One headcount plan: costed plan lines with the costed total against
 * the position budget, approve opens requisitions. Rows stay
 * loader-resolved; approval rides the per-line island button.
 */

const f = item

export function compPlanSpec(data: NonNullable<Awaited<ReturnType<typeof loadHeadcountPlanDetail>>>): PageSpec {
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
            columns: [
              column('title', text(item('title'))),
              column('kind', badge(item('kindLabel'))),
              column('fte', text(item('fte')), { align: 'right', className: 'tabular-nums' }),
              column('start', text(item('startOn'))),
              column('cost', text(item('cost')), { align: 'right', className: 'tabular-nums' }),
              column('status', badge(item('statusLabel'), { variant: item('statusVariant') })),
            ],
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
