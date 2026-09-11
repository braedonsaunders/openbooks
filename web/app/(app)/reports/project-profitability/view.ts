import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  filterBar,
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { dimensionOptions, projectProfitability, projectProfitabilityCustomerOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, REPORT_PARAM_KEYS, toSearchParams } from '../../../../lib/report-filters'
import { orgBranding } from '../../../../lib/report-pdf'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { requirePermission } from '../../../../lib/authz'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import type { ProjectProfitabilityGroup } from './ProjectProfitabilityTable'
import { requireProjectsFeature } from '../../../../lib/projects-gate'

/**
 * Project profitability, split into a loader and a spec.
 *
 * The body is one `project-profitability-table` widget, not decomposed `table`
 * blocks — and the reason is worth stating. The native table owns client-side
 * collapse state (per-customer expand/collapse buttons with aria labels, plus
 * the expand-all/collapse-all event the filter bar fires), interleaves group
 * subtotal rows with project rows, and drills every metric cell through
 * report-drill targets while linking only the project-name cell to the P&L.
 * Re-expressing that as generic columns would reimplement it, badly — the
 * same reason `paper-view` and `statement-matrix` stay whole. ViewSpec
 * composes the page; it does not re-derive the component.
 *
 * The `sections` filter-bar control is data-driven (present only when a group
 * has projects to expand), and spec controls are static booleans by design —
 * so the spec places TWO filter bars behind complementary loader flags, the
 * same treatment the budget page gave its data-driven `sections` control.
 *
 * The bar's customer dropdown needed a `customer` flag on
 * `FilterBarControls`. The renderer already forwarded `customers`; only the
 * control flag was missing, so the language gained it — one boolean added to
 * a closed union, which is what extending this vocabulary is meant to cost.
 */

export interface ProjectProfitabilityData {
  title: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  primaryFilter: {
    paramKey: string
    label: string
    value: string
    options: { value: string; label: string }[]
  }
  showSections: boolean
  hideSections: boolean
  dateRange: { from: string; to: string }
  customers: { id: string; name: string }[]
  dimensions: unknown
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string | undefined>
  company: string
  periodPhrase: string
  emptyLabel: string
  currency: string
  columns: string[]
  groups: ProjectProfitabilityGroup[]
  totalLabel: string
  totals: ProjectProfitabilityGroup['values']
  totalDrills: ProjectProfitabilityGroup['drills']
}

export async function loadProjectProfitability(
  sp: Record<string, string | undefined>,
): Promise<ProjectProfitabilityData> {
  const t = await getTranslations('reports')
  const authz = await requirePermission('reports.read')
  await requireProjectsFeature(authz.user.orgId)
  const scheduleDefId = await reportScheduleAnchor('project-profitability')
  const search = sp.q?.trim() || undefined
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId })
  const dims = { ...q.dims, subsidiaryIds: authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds] }
  const [result, opts, customers, org, branding] = await Promise.all([
    projectProfitability(period.from, period.to, {
      dims,
      customerId: q.customerId,
      search,
      projectScope: q.projectScope,
      orgId: authz.user.orgId,
    }),
    dimensionOptions(authz.user.orgId),
    projectProfitabilityCustomerOptions(authz.user.orgId),
    orgInfo(authz.user.orgId),
    orgBranding(authz.user.orgId),
  ])
  if (!org?.base_currency) throw new Error('Organization base currency is not configured')

  // Each project drills into the P&L filtered on that project (period + basis +
  // other dims preserved). Link only the project-name cell.
  const pnlHref = (projectId: string) =>
    `/reports/pnl?${toSearchParams({ ...q, customerId: undefined, dims: { ...q.dims, projectId } }).toString()}`

  const profitDrills = (
    label: string,
    scope: { projectId?: string; customerId?: string; unassignedCustomer?: boolean; search?: string } = {},
  ) => {
    const ledger = (accountTypes: string[], profitSigned = false): ReportDrillTarget => ({
      kind: 'ledger', label, accountTypes, from: period.from, to: period.to, mode: 'flow',
      dims: scope.projectId ? { ...dims, projectId: scope.projectId } : dims,
      projectCustomerId: scope.customerId,
      unassignedProjectCustomer: scope.unassignedCustomer,
      projectSearch: scope.search,
      activeProjectsOnly: q.projectScope === 'active' && !scope.projectId,
      profitSigned,
      basis: q.basis,
    })
    const revenue = ['income', 'income_other']
    const expenses = ['expense', 'expense_other', 'expense_deferred']
    const net = ledger([...revenue, 'cogs', ...expenses], true)
    return {
      revenue: ledger(revenue),
      cogs: ledger(['cogs']),
      grossProfit: ledger([...revenue, 'cogs'], true),
      expenses: ledger(expenses),
      net,
      margin: net,
      hours: {
        kind: 'time', label, from: period.from, to: period.to,
        projectId: scope.projectId,
        projectCustomerId: scope.customerId,
        unassignedProjectCustomer: scope.unassignedCustomer,
        projectSearch: scope.search,
        activeProjectsOnly: q.projectScope === 'active' && !scope.projectId,
      } satisfies ReportDrillTarget,
    }
  }

  const groups: ProjectProfitabilityGroup[] = result.customers.map((customer) => {
    const name = customer.customerName ?? t('projectProfitability.noCustomer')
    const scope = customer.customerId
      ? { customerId: customer.customerId }
      : { unassignedCustomer: true }
    return {
      key: customer.customerId ?? 'unassigned',
      name,
      expandLabel: t('projectProfitability.expandCustomer', { customer: name }),
      collapseLabel: t('projectProfitability.collapseCustomer', { customer: name }),
      values: customer.totals,
      drills: profitDrills(name, { ...scope, search }),
      projects: customer.rows.map((project) => ({
        id: project.projectId,
        name: project.projectName,
        pnlHref: pnlHref(project.projectId),
        values: project,
        drills: profitDrills(project.projectName, { projectId: project.projectId }),
      })),
    }
  })
  const totalLabel = t('trialBalance.totals')

  return {
    title: t('projectProfitability.title'),
    backHref: '/reports',
    backLabel: t('hub.title'),
    searchPlaceholder: t('projectProfitability.searchPlaceholder'),
    primaryFilter: {
      paramKey: REPORT_PARAM_KEYS.projectScope,
      label: t('projectProfitability.projectScope'),
      value: q.projectScope,
      options: [
        { value: 'active', label: t('projectProfitability.activeProjects') },
        { value: 'all', label: t('projectProfitability.allProjects') },
      ],
    },
    // The native bar shows the expand/collapse-all Options popover only when
    // some group has projects to expand. Presence, not branching: two flags.
    showSections: groups.some((group) => group.projects.length > 0),
    hideSections: !groups.some((group) => group.projects.length > 0),
    dateRange: { from: period.from, to: period.to },
    customers,
    dimensions: opts,
    scheduleDefId: scheduleDefId ?? null,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: sp,
    company: branding.orgName,
    periodPhrase: t('pnl.dateRange', { from: period.from, to: period.to }),
    emptyLabel: t('projectProfitability.empty'),
    currency: org.base_currency,
    columns: [
      t('projectProfitability.columns.customerJob'),
      t('projectProfitability.columns.revenue'),
      t('projectProfitability.columns.cogs'),
      t('projectProfitability.columns.grossProfit'),
      t('projectProfitability.columns.expenses'),
      t('projectProfitability.columns.net'),
      t('projectProfitability.columns.margin'),
      t('projectProfitability.columns.hours'),
    ],
    groups,
    totalLabel,
    totals: result.totals,
    totalDrills: profitDrills(totalLabel, { customerId: q.customerId, search }),
  }
}

const f = ref<ProjectProfitabilityData>()

export function projectProfitabilitySpec(data: ProjectProfitabilityData): PageSpec {
  const actions = [
    widget(
      'schedule-report',
      { definitionId: data.scheduleDefId ?? '', statementParams: data.scheduleParams },
      f('scheduleDefId'),
    ),
    widget('save-view'),
    widget('export-menu', { kind: 'project-profitability', params: data.exportParams }),
  ]
  return page({
    route: '/reports/project-profitability',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      // Complementary pair: the native bar carries the sections (expand-all /
      // collapse-all) Options popover only when a group has projects.
      // `customers` binds on both bars already; the dropdown itself needs
      {
        ...filterBar(
          { search: true, dateRange: true, customer: true, dimensions: true, sections: true },
          {
            searchPlaceholder: f('searchPlaceholder'),
            primaryFilter: f('primaryFilter'),
            customers: f('customers'),
            dimensions: f('dimensions'),
            dateRange: f('dateRange'),
            actions,
          },
        ),
        when: f('showSections'),
      },
      {
        ...filterBar(
          { search: true, dateRange: true, customer: true, dimensions: true },
          {
            searchPlaceholder: f('searchPlaceholder'),
            primaryFilter: f('primaryFilter'),
            customers: f('customers'),
            dimensions: f('dimensions'),
            dateRange: f('dateRange'),
            actions,
          },
        ),
        when: f('hideSections'),
      },
    ],
    body: [
      // The profitability table stays whole: collapse state, subtotal rows,
      // per-cell drills and the project-name P&L link live in the component.
      widgetBlock('project-profitability-table', {
        company: data.company,
        title: data.title,
        periodPhrase: data.periodPhrase,
        columns: data.columns,
        emptyLabel: data.emptyLabel,
        currency: data.currency,
        groups: data.groups,
        totalLabel: data.totalLabel,
        totals: data.totals,
        totalDrills: data.totalDrills,
      }),
    ],
  })
}
