import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, projectProfitability, projectProfitabilityCustomerOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, REPORT_PARAM_KEYS, toSearchParams } from '../../../../lib/report-filters'
import { orgBranding } from '../../../../lib/report-pdf'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'
import { ScheduleReportButton } from '../ScheduleReportButton'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { ExportMenu } from '../ExportMenu'
import { requirePermission } from '../../../../lib/authz'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import { ProjectProfitabilityTable, type ProjectProfitabilityGroup } from './ProjectProfitabilityTable'
import { requireProjectsFeature } from '../../../../lib/projects-gate'

export const dynamic = 'force-dynamic'
export default async function ProjectProfitabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const authz = await requirePermission('reports.read')
  await requireProjectsFeature(authz.user.orgId)
  const sp = await searchParams
  const scheduleDefId = await reportScheduleAnchor('project-profitability')
  const search = sp.q?.trim() || undefined
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId })
  const dims = q.dims
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

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('projectProfitability.title')}
            back={{ href: '/reports', label: t('hub.title') }}
          />
          <ReportFilterBar
            controls={{ search: true, dateRange: true, customer: true, dimensions: true, sections: groups.some((group) => group.projects.length > 0) }}
            dateRange={{ from: period.from, to: period.to }}
            searchPlaceholder={t('projectProfitability.searchPlaceholder')}
            primaryFilter={{
              paramKey: REPORT_PARAM_KEYS.projectScope,
              label: t('projectProfitability.projectScope'),
              value: q.projectScope,
              options: [
                { value: 'active', label: t('projectProfitability.activeProjects') },
                { value: 'all', label: t('projectProfitability.allProjects') },
              ],
            }}
            customers={customers}
            dimensions={opts}
            actions={<>{scheduleDefId ? <ScheduleReportButton definitionId={scheduleDefId} statementParams={scheduleParamsFrom(sp)} /> : null}<SaveViewButton /><ExportMenu kind="project-profitability" params={sp} /></>}
          />
        </>
      }
    >
      <ProjectProfitabilityTable
        company={branding.orgName}
        title={t('projectProfitability.title')}
        periodPhrase={t('pnl.dateRange', { from: period.from, to: period.to })}
        currency={org.base_currency}
        emptyLabel={t('projectProfitability.empty')}
        columns={[
          t('projectProfitability.columns.customerJob'),
          t('projectProfitability.columns.revenue'),
          t('projectProfitability.columns.cogs'),
          t('projectProfitability.columns.grossProfit'),
          t('projectProfitability.columns.expenses'),
          t('projectProfitability.columns.net'),
          t('projectProfitability.columns.margin'),
          t('projectProfitability.columns.hours'),
        ]}
        groups={groups}
        totalLabel={totalLabel}
        totals={result.totals}
        totalDrills={profitDrills(totalLabel, { customerId: q.customerId, search })}
      />
    </ListPageLayout>
  )
}
