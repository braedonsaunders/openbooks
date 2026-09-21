import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  badge,
  column,
  field,
  grid,
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
import { loadProcessesPage, type ProcessesPageData } from '../../../../lib/hrm/processes-page'

/**
 * Process checklists — the /hrm sibling tab for employment starts, ends,
 * and transfers, split into a loader and a spec.
 *
 * Follows the positions list archetype: ViewSpec composes the header, the
 * shared `filter-chips` segment filter, and the `table` block over
 * loader-resolved rows; the URL drawer stays a component shared by the page
 * and the widget registry via ./sections so they cannot drift. Segments
 * filter server-side through listProcesses; a row opens the checklist drawer (owners, due dates,
 * evidence, complete/skip actions) through the URL, so the selection is
 * shareable and the drawer closes by navigation. Renders only when the hrm
 * feature gate is on and the actor holds hrm.process.read — the view 404s
 * otherwise.
 */

const f = ref<ProcessesPageData>()
const item = field

export function processesSpec(data: ProcessesPageData): PageSpec {
  return page({
    route: '/hrm/processes',
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
        widgetBlock('filter-chips', {
          basePath: '/hrm/processes',
          currentParams: data.currentParams,
          paramKey: 'segment',
          label: data.segmentsLabel,
          hideAll: true,
          defaultValue: 'open',
          options: data.segmentOptions,
        }),
        panel({
          title: f('listTitle'),
          iconKey: 'clipboard-check',
          className: 'min-h-0 flex-1',
          bodyClassName: 'p-0',
          blocks: [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              empty: { title: f('empty') },
              columns: [
                column(data.columns.employee, link(item('workerName'), item('href'))),
                column(data.columns.kind, text(item('kindLabel'))),
                column(data.columns.status, badge(item('statusLabel'), { variant: item('statusVariant') })),
                column(data.columns.effective, text(item('effectiveDate')), { className: 'tabular-nums' }),
                column(
                  data.columns.progress,
                  text(item('progressLabel'), {
                    suffix: {
                      field: item('overdueBadge'),
                      className:
                        'ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300',
                    },
                  }),
                  { align: 'right', className: 'tabular-nums' },
                ),
                column(data.columns.nextDue, text(item('nextDueOn'), { fallback: '—' }), {
                  align: 'right',
                  className: 'tabular-nums',
                }),
              ],
            }),
          ],
        }),
      ]),
      // URL-backed drawer, portaled to <body> wherever it renders.
      {
        ...widgetBlock('hrm-process-drawer', { drawer: data.drawer }),
        when: f('drawerOpen'),
      },
      // HR-21: the shared evidence-draft drawer (?draft=<kind>:<id>).
      {
        ...widgetBlock('hrm-ai-draft-drawer', { draft: data.draftDrawer }),
        when: f('draftDrawerOpen'),
      },
    ],
  })
}

export async function loadProcessesRoute(
  sp: Record<string, string | undefined>,
): Promise<ProcessesPageData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.process.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadProcessesPage(authz, sp)
}

export async function processesTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('processes.title')
}
