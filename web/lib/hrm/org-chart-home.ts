import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { loadDirectory, loadOrgChart } from '@openbooks/engine/src/hrm/org-chart.ts'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { hrmPeopleViewTabs } from './workspace-tabs'
import { can, getAuthz, type Authz } from '../authz'
import { requireFeatureEnabled } from '../feature-gates'

/**
 * Org chart loader (0230, HR-19).
 *
 * The tree and the directory resolve through the canonical engine
 * reads (loadOrgChart, loadDirectory) as of a civil date — names,
 * titles, departments, and managers only, never pay or private
 * fields. Renders when hrm and hrmOrgChart are on and the actor holds
 * hrm.employment.read OR hrm.self.read — a switched-off feature redirects
 * to its remedy instead.
 * The Directory sub-tab renders the same loader rows through the
 * shared `table` block: RecordListView's registry serves document
 * record types only, and bending its document drawer machinery around
 * people rows would fork it — the loader-resolved table is the house
 * HRM pattern.
 */

export interface OrgChartHomeAuthz {
  orgId: string
  userId: string
  session: Authz
}

export async function orgChartAuthz(): Promise<OrgChartHomeAuthz | null> {
  const gate = await getAuthz()
  if (!gate) return null
  if (!can(gate, 'hrm.employment.read') && !can(gate, 'hrm.self.read')) return null
  await requireFeatureEnabled(gate.user.orgId, 'hrm')
  await requireFeatureEnabled(gate.user.orgId, 'hrmOrgChart')
  return { orgId: gate.user.orgId, userId: gate.user.id, session: gate }
}

export async function loadOrgChartHome(
  authz: OrgChartHomeAuthz,
  sp: Record<string, string | undefined>,
) {
  const t = await getTranslations('hrm')
  const tabs = await hrmGroupTabs(authz.session, '/hrm/org-chart')
  const peopleTabs = await hrmPeopleViewTabs(authz.session, '/hrm/org-chart')
  const today = await businessToday(authz.orgId)
  const asOf = typeof sp.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : today
  const view = sp.view === 'directory' ? 'directory' : 'tree'
  const search = typeof sp.q === 'string' ? sp.q.trim().toLowerCase() : ''

  const [chart, directory] = await Promise.all([
    loadOrgChart({ orgId: authz.orgId, actorId: authz.userId, asOf }),
    view === 'directory'
      ? loadDirectory({
          orgId: authz.orgId,
          actorId: authz.userId,
          ...(search ? { search } : {}),
          limit: 200,
        })
      : Promise.resolve([]),
  ])

  const personBaseHref = `/hrm/org-chart?asOf=${asOf}`
  const selectedId = typeof sp.person === 'string' && sp.person.length > 0 ? sp.person : null

  function findNode(
    nodes: typeof chart.roots,
    employmentId: string,
  ): (typeof chart.roots)[number] | null {
    for (const node of nodes) {
      if (node.employmentId === employmentId) return node
      const found = findNode(node.children, employmentId)
      if (found) return found
    }
    return null
  }
  const selected = selectedId ? findNode(chart.roots, selectedId) : null

  const directoryRows = directory.map((entry) => ({
      id: entry.employmentId,
      name: entry.name,
      title: entry.title,
      department: entry.department,
      manager: entry.managerName,
      href: `/hrm/org-chart?asOf=${asOf}&person=${entry.employmentId}`,
    }))

  return {
    title: t('orgChart.title'),
    description: t('orgChart.description'),
    tabs,
    asOf,
    today,
    view,
    treeHref: `/hrm/org-chart?asOf=${asOf}`,
    directoryHref: `/hrm/org-chart?asOf=${asOf}&view=directory`,
    treeLabel: t('orgChart.tree'),
    directoryLabel: t('orgChart.directory'),
    // People job strip (employees, org chart, processes, documents,
    // qualifications). Tree vs directory is the same rows in two shapes —
    // a list-toolbar view filter, not a second tab strip.
    viewTabs: peopleTabs,
    search,
    chart,
    directoryRows,
    directoryColumns: {
      name: t('orgChart.columns.name'),
      title: t('orgChart.columns.title'),
      department: t('orgChart.columns.department'),
      manager: t('orgChart.columns.manager'),
    },
    directoryEmpty: t('orgChart.directoryEmpty'),
    searchLabel: t('orgChart.search'),
    asOfLabel: t('orgChart.asOf'),
    /** URL state the shared toolbar preserves when a control changes. */
    currentParams: {
      ...(view === 'directory' ? { view: 'directory' } : {}),
      ...(search ? { q: search } : {}),
      asOf,
    },
    personBaseHref,
    selected,
    personCloseHref: `/hrm/org-chart?asOf=${asOf}${view === 'directory' ? '&view=directory' : ''}`,
    // `orgChart.labels.*`, not `orgChart.*`. Every one of these twelve keys
    // was read one segment too high, and next-intl answers a miss with the
    // key path — so the headcount tile was captioned HRM.ORGCHART.HEADCOUNT
    // on the live page, and the tree's own strings ("Vacant", "Span of
    // control") were raw keys too. `messages/index.test.ts` now fails on a
    // key no catalog carries, which is what would have caught this.
    labels: {
      vacancies: t('orgChart.labels.vacancies'),
      headcount: t('orgChart.labels.headcount'),
      layers: t('orgChart.labels.layers'),
      span: t('orgChart.labels.span'),
      vacant: t('orgChart.labels.vacant'),
      department: t('orgChart.labels.department'),
      manager: t('orgChart.labels.manager'),
      reports: t('orgChart.labels.reports'),
      close: t('orgChart.labels.close'),
      expand: t('orgChart.labels.expand'),
      collapse: t('orgChart.labels.collapse'),
      noMatch: t('orgChart.labels.noMatch'),
      empty: t('orgChart.labels.empty'),
    },
  }
}
