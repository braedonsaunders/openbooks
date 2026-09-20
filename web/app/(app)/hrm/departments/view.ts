import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
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
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadHrmDepartments, type HrmDepartmentsData } from '../../../lib/hrm/departments'

/**
 * The department headcount board, split into a loader and a spec.
 *
 * Reuse, not a second table: the numbers render through the shared
 * `hrm-headcount-table` widget over loader-resolved rows — the same
 * component the cockpit hero uses — and the working links through the
 * shared `directory-section`. The only page-specific copy is the chrome
 * plus the honest drill-through hint.
 */

const f = ref<HrmDepartmentsData>()

export function hrmDepartmentsSpec(data: HrmDepartmentsData): PageSpec {
  return page({
    route: '/hrm/departments',
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
          iconKey: 'building',
          hint: f('listNote'),
          bodyClassName: 'p-0',
          className: 'min-h-0',
          blocks: [
            widgetBlock('hrm-headcount-table', {
              groups: data.groups,
              total: data.total,
              employerColumn: data.employerColumn,
              departmentColumn: data.departmentColumn,
              headcountColumn: data.headcountColumn,
              unassigned: data.unassigned,
              empty: data.groupsEmpty,
              totalLabel: data.totalLabel,
            }),
          ],
        }),
        widgetBlock('directory-section', {
          items: data.directory,
          title: data.linksTitle,
        }),
      ]),
    ],
  })
}

export async function loadHrmDepartmentsPage(): Promise<HrmDepartmentsData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.employment.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadHrmDepartments(authz)
}

export async function hrmDepartmentsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('departments.title')
}
