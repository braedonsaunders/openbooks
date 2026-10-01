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
  pagination,
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
 * sub-view over the shared `table` block. Renders when hrm is on and
 * the actor holds hrm.employment.read OR hrm.self.read — the loader
 * 404s otherwise.
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
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        // An impossible bookmarked date corrects to the business date in
        // the loader; the correction is named above the chart, never
        // silent and never a route error.
        {
          ...widgetBlock('empty-state', {
            title: data.dateRefusal?.title ?? '',
            description: data.dateRefusal?.description ?? '',
          }),
          when: f('dateRefusal'),
        },
        // The as-of/search controls on the shared toolbar. The Employees
        // view switch is the page layout's, in the header action rail.
        grid('flex shrink-0 flex-wrap items-center gap-3', [
          widgetBlock('list-toolbar', {
            basePath: '/hrm/org-chart',
            currentParams: data.currentParams,
            search: { paramKey: 'q', placeholder: data.searchLabel },
            date: {
              paramKey: 'asOf',
              label: data.asOfLabel,
              max: data.today,
              resolved: data.asOf,
            },
            filters: [
              {
                paramKey: 'view',
                label: data.treeLabel,
                allLabel: data.treeLabel,
                options: [{ value: 'directory', label: data.directoryLabel }],
              },
            ],
          }),
        ]),
        ...(data.view === 'directory'
          ? [
              // Directory is already named by the active view tab. Render
              // the shared table directly, like every sibling list, so its
              // empty state owns the available surface instead of sitting
              // in a second, partly-filled card inside the page.
              grid('min-h-0 flex-1 overflow-y-auto', [
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
              ]),
              pagination({
                basePath: '/hrm/org-chart',
                total: f('directoryTotal'),
                page: f('directoryPage'),
                perPage: f('directoryPageSize'),
                bare: true,
              }),
            ]
          : [
              grid('min-h-0 flex-1', [
                widgetBlock('org-chart-tree', {
                  chart: data.chart,
                  personBaseHref: data.personBaseHref,
                  labels: data.labels,
                  canManage: data.canManage,
                  today: data.today,
                  departmentOptions: data.departmentOptions,
                }),
              ]),
            ]),
      ]),
      {
        ...widgetBlock('hrm-org-chart-person', {
          selected: data.selected,
          manager: data.manager,
          canManage: data.canManage,
          today: data.today,
          departmentOptions: data.departmentOptions,
          closeHref: data.personCloseHref,
          labels: data.labels,
        }),
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
