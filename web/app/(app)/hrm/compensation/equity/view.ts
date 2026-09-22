import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  page,
  pageHeader,
  panel,
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { compensationAuthz, loadEquity } from '../../../../../lib/hrm/compensation'

/**
 * Pay equity: the latest frozen snapshot with the seven Article 9
 * metrics as tiles and the per-category table with the joint-assessment
 * flag; the generate action opens the snapshot dialog. Export rides the
 * report engine (hrm_pay_gap_snapshots). Renders only when
 * hrmPayTransparency is on and the actor holds hrm.compensation.read.
 */

const f = item

export function equitySpec(data: NonNullable<Awaited<ReturnType<typeof loadEquity>>>): PageSpec {
  return page({
    route: '/hrm/compensation/equity',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('asOf'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('generateHref'), label: f('generateLabel'), iconKey: 'plus' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
      // A refused snapshot read renders with its remedy intact while the
      // snapshot-specific grid and table stay hidden — a refusal must
      // never present the no-categories claim. Genuine no-snapshot
      // emptiness keeps its table (the leave-queue `hasContent` pattern).
      widgetBlock('empty-state', { title: data.refusal?.title ?? '', description: data.refusal?.message }, f('refusal')),
      {
        ...grid('grid grid-cols-2 gap-4 xl:grid-cols-4', [
          statTile({ iconKey: f('tiles.0.iconKey'), accent: f('tiles.0.accent'), label: f('tiles.0.label'), value: f('tiles.0.value'), tone: f('tiles.0.tone') }),
          statTile({ iconKey: f('tiles.1.iconKey'), accent: f('tiles.1.accent'), label: f('tiles.1.label'), value: f('tiles.1.value'), tone: f('tiles.1.tone') }),
          statTile({ iconKey: f('tiles.2.iconKey'), accent: f('tiles.2.accent'), label: f('tiles.2.label'), value: f('tiles.2.value'), tone: f('tiles.2.tone') }),
          statTile({ iconKey: f('tiles.3.iconKey'), accent: f('tiles.3.accent'), label: f('tiles.3.label'), value: f('tiles.3.value'), tone: f('tiles.3.tone') }),
        ]),
        when: f('hasContent'),
      },
      {
        ...panel({
          title: f('categoriesTitle'),
          bodyClassName: 'min-h-0 overflow-y-auto p-0',
          className: 'min-h-0 flex-1',
          blocks: [
            table({
              variant: 'app',
              rows: f('categories'),
              rowKey: item('id'),
              empty: { title: f('categoriesEmpty') },
              columns: [
                column('category', text(item('level'))),
                column('counts', text(item('counts')), { align: 'right', className: 'tabular-nums' }),
                column('mean', text(item('mean')), { align: 'right', className: 'tabular-nums' }),
                column('median', text(item('median')), { align: 'right', className: 'tabular-nums' }),
                column('unexplained', text(item('unexplained')), { align: 'right', className: 'tabular-nums' }),
                column('flag', badge(item('flag'), { variant: item('flagTone') })),
              ],
            }),
          ],
        }),
        when: f('hasContent'),
      },
    ],
  })
}

export async function equityTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('equity.title')
}

export async function loadEquityPage() {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadEquity(authz)
  if (!data) notFound()
  return data
}
