import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { isCivilDate } from '@openbooks/engine/src/hrm/temporal.ts'
import { loadDirectory } from '@openbooks/engine/hrm/org-chart'
import { loadOrgChartWorkspace } from '@openbooks/engine/hrm/org-chart'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { can, getAuthz, type Authz } from '../authz'
import { requireFeatureEnabled } from '../feature-gates'
import { listScopedDepartmentOptions } from '../scoped-options'

/** The chart resolves native names, titles and reporting lines only. A dedicated
 * chart permission grants this basic read without opening employment records.
 * Self-service readers retain their own and direct-report scope. */

export interface OrgChartHomeAuthz {
  orgId: string
  userId: string
  session: Authz
}

export async function orgChartAuthz(): Promise<OrgChartHomeAuthz | null> {
  const gate = await getAuthz()
  if (!gate) return null
  if (!can(gate, 'hrm.org_chart.read') && !can(gate, 'hrm.employment.read') && !can(gate, 'hrm.self.read')) return null
  await requireFeatureEnabled(gate.user.orgId, 'hrm')
  return { orgId: gate.user.orgId, userId: gate.user.id, session: gate }
}

export async function loadOrgChartHome(
  authz: OrgChartHomeAuthz,
  sp: Record<string, string | undefined>,
) {
  const t = await getTranslations('hrm')
  const common = await getTranslations('common')
  const tabs = await hrmGroupTabs(authz.session, '/hrm/org-chart')
  const today = await businessToday(authz.orgId)
  // Shape is not enough: 2026-02-30 passes the regex and then throws out
  // of the chart reads as a VALIDATION error into the generic route
  // error. The shared strict parser refuses by calendar at this boundary
  // like the positions page: the chart corrects to the business date and
  // names the correction.
  const rawAsOf = typeof sp.asOf === 'string' ? sp.asOf : null
  const asOf = rawAsOf !== null && isCivilDate(rawAsOf) ? rawAsOf : today
  const dateRefusal =
    rawAsOf !== null && !isCivilDate(rawAsOf)
      ? {
          title: t('positions.invalidDateTitle'),
          description: t('positions.invalidDate', { date: rawAsOf, today: asOf }),
        }
      : null
  const canReadEmployee = can(authz.session, 'hrm.employment.read')
  const canReadDirectory = canReadEmployee || can(authz.session, 'hrm.self.read')
  const view = sp.view === 'directory' && canReadDirectory ? 'directory' : 'tree'
  const search = typeof sp.q === 'string' ? sp.q.trim().toLowerCase() : ''
  const requestedDirectoryPage = Number(sp.page ?? 1)
  const directoryPageNumber = Number.isSafeInteger(requestedDirectoryPage) && requestedDirectoryPage > 0
    ? requestedDirectoryPage
    : 1

  const [workspace, directoryPage] = await Promise.all([
    loadOrgChartWorkspace({ orgId: authz.orgId, actorId: authz.userId, asOf }),
    view === 'directory'
      ? loadDirectory({
          orgId: authz.orgId,
          actorId: authz.userId,
          asOf,
          ...(search ? { search } : {}),
          limit: 50,
          page: directoryPageNumber,
        })
      : Promise.resolve({ entries: [], totalCount: 0, page: 1, pageSize: 50 }),
  ])

  const { chart, layout } = workspace
  const canManage = can(authz.session, 'hrm.employment.manage') && can(authz.session, 'hrm.employment.read')
  const departmentOptions = canManage
    ? (await listScopedDepartmentOptions(authz.orgId, authz.session.allowedSubsidiaryIds)).map((row) => ({ value: row.id, label: row.name }))
    : []
  const currentParams = {
    ...(view === 'directory' ? { view: 'directory' } : {}),
    ...(search ? { q: search } : {}),
    ...(sp.department ? { department: sp.department } : {}),
    ...(sp.root ? { root: sp.root } : {}),
    ...(view === 'directory' && directoryPage.page > 1 ? { page: String(directoryPage.page) } : {}),
    asOf,
  }
  const personBaseHref = `/hrm/org-chart?${new URLSearchParams(currentParams)}`
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
  function findManager(nodes: typeof chart.roots): typeof selected {
    for (const node of nodes) {
      if (node.children.some((child) => child.employmentId === selectedId)) return node
      const found = findManager(node.children)
      if (found) return found
    }
    return null
  }
  const manager = selectedId ? findManager(chart.roots) : null

  const directoryRows = directoryPage.entries.map((entry) => ({
      id: entry.employmentId,
      name: entry.name,
      title: entry.title,
      department: entry.department,
      manager: entry.managerName,
      href: `${personBaseHref}&person=${entry.employmentId}`,
    }))

  return {
    title: t('orgChart.title'),
    description: t('orgChart.description'),
    tabs,
    asOf,
    today,
    dateRefusal,
    view,
    treeHref: `/hrm/org-chart?asOf=${asOf}`,
    directoryHref: `/hrm/org-chart?asOf=${asOf}&view=directory`,
    treeLabel: t('orgChart.tree'),
    directoryLabel: t('orgChart.directory'),
    // People job strip (employees, org chart, processes, documents,
    // qualifications). Tree vs directory is the same rows in two shapes —
    // a list-toolbar view filter, not a second tab strip.
    search,
    chart,
    layout,
    canManage,
    canReadEmployee,
    canEditLayout: canManage && authz.session.allowedSubsidiaryIds === null && asOf === today,
    departmentOptions,
    directoryRows,
    directoryTotal: directoryPage.totalCount,
    directoryPage: directoryPage.page,
    directoryPageSize: directoryPage.pageSize,
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
    currentParams,
    personBaseHref,
    selected,
    manager,
    personCloseHref: personBaseHref,
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
      allDepartments: t('orgChart.labels.allDepartments'),
      noDepartment: t('orgChart.labels.noDepartment'),
      expandAll: t('orgChart.labels.expandAll'),
      collapseAll: t('orgChart.labels.collapseAll'),
      editStructure: t('orgChart.labels.editStructure'),
      doneEditing: t('orgChart.labels.doneEditing'),
      focus: t('orgChart.labels.focus'),
      wholeOrganization: t('orgChart.labels.wholeOrganization'),
      missingFocus: t('orgChart.labels.missingFocus'),
      matches: t('orgChart.labels.matches'),
      clearFilters: t('orgChart.labels.clearFilters'),
      edit: t('orgChart.labels.edit'),
      openEmployee: t('orgChart.labels.openEmployee'),
      noReports: t('orgChart.labels.noReports'),
      noVisibleManager: t('orgChart.labels.noVisibleManager'),
      openPosition: t('orgChart.labels.openPosition'),
      panHint: t('orgChart.labels.panHint'),
      connectHint: t('orgChart.labels.connectHint'),
      approvalHint: t('orgChart.labels.approvalHint'),
      zoomIn: t('orgChart.labels.zoomIn'),
      zoomOut: t('orgChart.labels.zoomOut'),
      fit: t('orgChart.labels.fit'),
      minimap: t('orgChart.labels.minimap'),
      managerConnector: t('orgChart.labels.managerConnector'),
      employeeConnector: t('orgChart.labels.employeeConnector'),
      invalidConnection: t('orgChart.labels.invalidConnection'),
      preparingEdit: t('orgChart.labels.preparingEdit'),
      editFailed: t('orgChart.labels.editFailed'),
      noAssignment: t('orgChart.labels.noAssignment'),
      unavailablePerson: t('orgChart.labels.unavailablePerson'),
      unavailableHint: t('orgChart.labels.unavailableHint'),
      removeCard: t('orgChart.labels.removeCard'),
      startEmpty: t('orgChart.labels.startEmpty'),
      startHint: t('orgChart.labels.startHint'),
      readOnlyEmpty: t('orgChart.labels.readOnlyEmpty'),
      canvasTitle: t('orgChart.labels.canvasTitle'),
      cardsPlaced: t('orgChart.labels.cardsPlaced'),
      unsaved: t('orgChart.labels.unsaved'),
      saving: t('orgChart.labels.saving'),
      saveLayout: t('orgChart.labels.saveLayout'),
      saved: t('orgChart.labels.saved'),
      saveFailed: t('orgChart.labels.saveFailed'),
      sidebarTitle: t('orgChart.labels.sidebarTitle'),
      sidebarSearch: t('orgChart.labels.sidebarSearch'),
      addPlaceholder: t('orgChart.labels.addPlaceholder'),
      team: t('orgChart.labels.team'),
      role: t('orgChart.labels.role'),
      placeholder: t('orgChart.labels.placeholder'),
      onChart: t('orgChart.labels.onChart'),
      addToChart: t('orgChart.labels.addToChart'),
      applyPlaceholder: t('orgChart.labels.applyPlaceholder'),
      placeholderType: t('orgChart.labels.placeholderType'),
      placeholderName: t('orgChart.labels.placeholderName'),
      placeholderNote: t('orgChart.labels.placeholderNote'),
      discardPlaceholder: t('orgChart.labels.discardPlaceholder'),
      managerChangeConfirm: t.raw('orgChart.labels.managerChangeConfirm') as string,
      managerChangeTitle: t('orgChart.labels.managerChangeTitle'),
      reviewChange: t('orgChart.labels.reviewChange'),
      reconnectHint: t('orgChart.labels.reconnectHint'),
      linkedEdgeHint: t('orgChart.labels.linkedEdgeHint'),
      removeConnectionConfirm: t('orgChart.labels.removeConnectionConfirm'),
      removeConnection: t('orgChart.labels.removeConnection'),
      syncHint: t('orgChart.labels.syncHint'),
      placeholderHint: t('orgChart.labels.placeholderHint'),
      discardLayout: t('orgChart.labels.discardLayout'),
      discard: t('orgChart.labels.discard'),
      retry: common('actions.retry'),
      cancel: common('actions.cancel'),
    },
  }
}
