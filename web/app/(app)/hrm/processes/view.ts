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
 * and transfers. Segments (open, overdue, completed, cancelled) switch a
 * single list; the drawer carries the checklist with owners, due dates,
 * evidence, and the complete/skip actions with their refusals.
 *
 * The page gate lives here — where the route-gate scanner reads — and the
 * loader enforces nothing twice: it takes the authorized session as input.
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
        panel({
          title: f('listTitle'),
          iconKey: 'clipboard-check',
          className: 'min-h-0 flex-1',
          bodyClassName: 'p-0',
          blocks: [widgetBlock('hrm-processes', {})],
        }),
      ]),
    ],
  })
}

export async function loadProcessesRoute(): Promise<ProcessesPageData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.process.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadProcessesPage(authz)
}

export async function processesTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('processes.title')
}
