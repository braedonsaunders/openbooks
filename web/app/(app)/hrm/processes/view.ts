import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
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
import { loadProcessesPage, type ProcessesPageData } from '../../../../lib/hrm/processes-page'

/**
 * Process checklists — the /hrm sibling tab for employment starts, ends,
 * and transfers, split into a loader and a spec.
 *
 * Follows the positions list archetype: ViewSpec composes the header and
 * the grid; the segment pills, the checklist table, and the URL drawer
 * stay components shared by the page and the widget registry via
 * ./sections so they cannot drift. Segments filter server-side through
 * listProcesses; a row opens the checklist drawer (owners, due dates,
 * evidence, complete/skip actions) through the URL, so the selection is
 * shareable and the drawer closes by navigation. Renders only when the hrm
 * feature gate is on and the actor holds hrm.process.read — the view 404s
 * otherwise.
 */

const f = ref<ProcessesPageData>()

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
        widgetBlock('hrm-process-segments', {
          ariaLabel: data.title,
          segments: data.segments,
        }),
        panel({
          title: f('listTitle'),
          iconKey: 'clipboard-check',
          className: 'min-h-0 flex-1',
          bodyClassName: 'p-0',
          blocks: [
            widgetBlock('hrm-processes-table', {
              columns: data.columns,
              rows: data.rows,
              empty: data.empty,
            }),
          ],
        }),
      ]),
      // URL-backed drawer, portaled to <body> wherever it renders.
      {
        ...widgetBlock('hrm-process-drawer', { drawer: data.drawer }),
        when: f('drawerOpen'),
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
