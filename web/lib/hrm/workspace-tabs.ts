import 'server-only'

import { getTranslations } from 'next-intl/server'
import { can, type Authz } from '../authz'
import { featureEnabled, orgFeatureState } from '../features'
import type { ViewTabGroup } from '../../components/module-home/view-tab-match'
import { hrmViewTabGroupsFor } from './view-tab-registry'

/** Compatibility helpers for older HR loaders. The app shell owns native local navigation. */

function pathOf(href: string): string {
  return href.split('?')[0] ?? href
}

/** Parent destination mapping for stored layouts that still name a broad group strip. */
export function hrmStripParentHref(pageHref: string): string {
  const path = pathOf(pageHref)
  const rules: { prefix: string; parent: string }[] = [
    { prefix: '/hrm/compensation', parent: '/hrm/compensation' },
    { prefix: '/hrm/benefits', parent: '/hrm/compensation' },
    { prefix: '/hrm/positions', parent: '/hrm/recruiting' },
    { prefix: '/hrm/recruiting', parent: '/hrm/recruiting' },
    { prefix: '/hrm/org-chart', parent: '/entities/employees' },
    { prefix: '/hrm/processes', parent: '/entities/employees' },
    { prefix: '/hrm/documents', parent: '/entities/employees' },
    { prefix: '/hrm/qualifications', parent: '/entities/employees' },
    { prefix: '/hrm/surveys', parent: '/hrm/performance' },
    { prefix: '/hrm/performance', parent: '/hrm/performance' },
    { prefix: '/hrm/leave', parent: '/hrm/leave' },
    { prefix: '/hrm/compliance', parent: '/hrm/compliance' },
    { prefix: '/hrm/change-requests', parent: '/hrm' },
    { prefix: '/entities/employees', parent: '/entities/employees' },
    { prefix: '/hrm', parent: '/hrm' },
  ]
  for (const { prefix, parent } of rules) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return parent
  }
  return path
}

/**
 * Every HRM job's view strip for this viewer, resolved from the registry.
 * Empty while the HRM feature is off: there is no job to switch within.
 */
export async function hrmViewTabGroups(authz: Authz): Promise<ViewTabGroup[]> {
  const state = await orgFeatureState(authz.user.orgId)
  if (!featureEnabled(state, 'hrm')) return []
  const [t, tNav] = await Promise.all([getTranslations('hrm'), getTranslations('nav')])
  return hrmViewTabGroupsFor(
    (def) =>
      (!def.permission || can(authz, def.permission)) &&
      (!def.feature || featureEnabled(state, def.feature)),
    (def) => (def.ns === 'nav' ? tNav(def.key as never) : t(def.key as never)),
  )
}
