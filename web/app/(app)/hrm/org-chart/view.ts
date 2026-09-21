import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  column,
  grid,
  field,
  link,
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
import { loadOrgChartHome, orgChartAuthz } from '../../../../lib/hrm/org-chart-home'

/**
 * Org chart tab: the tree widget (collapsible nodes, vacancy nodes,
 * as-of picker, search-to-node, person drawer) with a Directory
 * sub-view over the shared `table` block. Renders when hrm and
 * hrmOrgChart are on and the actor holds hrm.employment.read OR
 * hrm.self.read — the loader 404s otherwise.
 */

const f = field
const item = field

export type OrgChartPageData = NonNullable<Awaited<ReturnType<typeof loadOrgChartHome>>>

export function orgChartSpec(data: OrgChartPageData): PageSpec {
  return page({
    route: '/hrm/org-chart',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('treeHref'), label: f('treeLabel'), variant: 'outline' }),
          widget('link-button', { href: f('directoryHref'), label: f('directoryLabel'), variant: 'outline' }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4', [
        statTile({ iconKey: 'users', accent: 'blue', label: f('labels.headcount'), value: f('chart.headcount'), tone: 'default' }),
        statTile({ iconKey: 'user-plus', accent: 'amber', label: f('labels.vacancies'), value: f('chart.vacancies'), tone: 'default' }),
        statTile({ iconKey: 'layers', accent: 'slate', label: f('labels.layers'), value: f('chart.layers'), tone: 'default' }),
        statTile({ iconKey: 'calendar', accent: 'slate', label: f('asOfLabel'), value: f('asOf'), tone: 'default' }),
      ]),
      ...(data.view === 'directory'
        ? [
            panel({
              title: f('directoryLabel'),
              bodyClassName: 'min-h-0 overflow-y-auto p-0',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('directoryRows'),
                  rowKey: item('id'),
                  empty: { title: f('directoryEmpty') },
                  columns: [
                    column(data.directoryColumns.name, link(item('name'), item('href'))),
                    column(data.directoryColumns.title, text(item('title'), { fallback: '—' })),
                    column(data.directoryColumns.department, text(item('department'), { fallback: '—' })),
                    column(data.directoryColumns.manager, text(item('manager'), { fallback: '—' })),
                  ],
                }),
              ],
            }),
          ]
        : [
            widgetBlock('org-chart-tree', {
              chart: data.chart,
              search: data.search,
              asOf: data.asOf,
              today: data.today,
              personBaseHref: data.personBaseHref,
              asOfLabel: data.asOfLabel,
              searchLabel: data.searchLabel,
              labels: data.labels,
            }),
          ]),
      {
        ...widgetBlock('hrm-org-chart-person', { selected: data.selected, closeHref: data.personCloseHref, labels: data.labels }),
        when: f('selected'),
      },
    ],
  })
}

export async function orgChartTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('orgChart.title')
}

export async function loadOrgChartPage(sp: Record<string, string | undefined>) {
  const authz = await orgChartAuthz()
  if (!authz) notFound()
  return loadOrgChartHome(authz, sp)
}
