import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field,
  link,
  page,
  pageHeader,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { loadSurveysHome, surveysAuthz } from '../../../../lib/hrm/surveys-home'

/**
 * Surveys tab: the register with participation % as a shared `table`
 * block with `filter-chips` status segments, the header link-button
 * opening the author dialog through the URL, and row links opening the
 * survey drawer — the results panel (eNPS tile, driver bars, the
 * suppression-marked heatmap, comments, pulse trend) with open/close
 * actions — through the URL. Renders only when hrm and hrmSurveys are
 * on and the actor holds hrm.surveys.manage — the loader 404s
 * otherwise.
 */

const f = field
const item = field

export type SurveysPageData = NonNullable<Awaited<ReturnType<typeof loadSurveysHome>>>

export function surveysSpec(data: SurveysPageData): PageSpec {
  return page({
    route: '/hrm/surveys',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('addHref'), label: f('addLabel'), iconKey: 'plus' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        widgetBlock('filter-chips', {
          basePath: '/hrm/surveys',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.segmentsLabel,
          allLabel: data.allLabel,
          options: data.segmentOptions,
        }),
        table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          empty: { title: f('empty') },
          columns: [
            column(data.columns.name, link(item('name'), item('href'))),
            column(data.columns.kind, text(item('kindLabel'))),
            column(data.columns.anonymity, text(item('anonymityLabel'))),
            column(data.columns.participation, text(item('participation'), { fallback: '—' }), { align: 'right', className: 'tabular-nums' }),
            column(data.columns.closes, text(item('closes'), { fallback: '—' })),
            column(data.columns.status, badge(item('statusLabel'), { variant: item('statusVariant') })),
          ],
        }),
      ]),
      {
        ...widgetBlock('hrm-surveys-drawer', { drawer: data.drawer }),
        when: f('drawerOpen'),
      },
      {
        ...widgetBlock('hrm-surveys-author-dialog', { author: data.author }),
        when: f('authorOpen'),
      },
    ],
  })
}

export async function surveysTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('surveys.title')
}

export async function loadSurveysPage(sp: Record<string, string | undefined>) {
  const authz = await surveysAuthz()
  if (!authz) notFound()
  return loadSurveysHome(authz, sp)
}
