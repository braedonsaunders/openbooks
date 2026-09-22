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
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        // Three tiles, not four: the as-of date is a toolbar CONTROL now, so
        // a tile repeating it back is one of two places showing the same
        // fact and the only one you cannot change.
        grid('grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-3', [
          statTile({
            iconKey: 'users',
            accent: 'blue',
            label: f('labels.headcount'),
            value: f('chart.headcount'),
            tone: 'default',
          }),
          statTile({
            iconKey: 'user-plus',
            accent: 'amber',
            label: f('labels.vacancies'),
            value: f('chart.vacancies'),
            tone: 'default',
          }),
          statTile({
            iconKey: 'layers',
            accent: 'slate',
            label: f('labels.layers'),
            value: f('chart.layers'),
            tone: 'default',
          }),
        ]),
        // View switch + the as-of/search controls: one row, the shared strip
        // and the shared toolbar, in that order — the same shape every other
        // list in the product now uses.
        grid('flex shrink-0 flex-wrap items-center justify-between gap-3', [
          widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
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
            ]
          : [
              // The tree remains a panel because its canvas needs a named,
              // bounded scrolling surface; unlike Directory it is not a
              // native list table.
              panel({
                title: f('treeLabel'),
                iconKey: 'network',
                className: 'min-h-0 flex-1',
                bodyClassName: 'min-h-0 overflow-auto p-4',
                blocks: [
                  widgetBlock('org-chart-tree', {
                    chart: data.chart,
                    personBaseHref: data.personBaseHref,
                    labels: data.labels,
                  }),
                ],
              }),
            ]),
      ]),
      {
        ...widgetBlock('hrm-org-chart-person', {
          selected: data.selected,
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
