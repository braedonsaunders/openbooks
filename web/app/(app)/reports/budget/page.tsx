import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { budgetScenarioOptions, budgetVsActualView } from '../../../../lib/budget-report'
import { orgInfo } from '../../../../lib/data'
import { StatementMatrixTable } from '../StatementMatrixTable'
import { SaveViewButton } from '../SaveViewButton'
import { ExportMenu } from '../ExportMenu'
import { ReportFilterBar } from '../ReportFilterBar'
import { parseReportQuery } from '../../../../lib/report-filters'
import { can, requirePermission } from '../../../../lib/authz'
import { loadBudgetDimensionOptions } from '../../../../lib/budgets'
import { ReportPaper } from '../ReportPaper'

export const dynamic = 'force-dynamic'

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const tb = await getTranslations('budgets')
  const authz = await requirePermission('reports.read')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const [scenarios, dimensions, org] = await Promise.all([
    budgetScenarioOptions(authz.user.orgId),
    loadBudgetDimensionOptions(authz.user.orgId),
    orgInfo(authz.user.orgId),
  ])
  const manageAction = can(authz, 'budgets.read') ? <Button variant="outline" size="sm" asChild><Link href="/budgets">{t('budget.manage')}</Link></Button> : null

  if (scenarios.length === 0) {
    return (
      <ListPageLayout
        header={
          <>
            <PageHeader title={t('budget.title')} back={{ href: '/reports', label: t('hub.title') }} />
            <ReportFilterBar controls={{ period: false }} actions={manageAction} />
          </>
        }
      >
        <ReportPaper company={org?.name ?? ''} title={t('budget.title')} periodPhrase={t('budget.description')}>
          <p className="py-8 text-center text-slate-400 italic">{t('budget.noScenarios')}</p>
        </ReportPaper>
      </ListPageLayout>
    )
  }

  const scenarioId = sp.scenario && scenarios.some((s) => s.id === sp.scenario) ? sp.scenario : scenarios[0]!.id
  const labels = {
    actual: t('budget.actual'),
    budget: t('budget.budget'),
    variance: t('budget.variance'),
    variancePct: t('budget.variancePct'),
    revenue: t('pnl.revenue'),
    costOfGoodsSold: t('pnl.costOfGoodsSold'),
    grossProfit: t('pnl.grossProfit'),
    expenses: t('pnl.expenses'),
    netIncome: t('pnl.netIncome'),
    totalOf: (section: string) => t('statement.sectionTotal', { section }),
  }
  const view = await budgetVsActualView(scenarioId, authz.user.orgId, labels, q.dims)
  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('budget.title')}
            back={{ href: '/reports', label: t('hub.title') }}
          />
          <ReportFilterBar
            controls={{ period: false, dimensions: true, sections: Boolean(view) }}
            primaryFilter={{
              paramKey: 'scenario',
              label: t('budget.scenario'),
              value: scenarioId,
              options: scenarios.map((scenario) => ({
                value: scenario.id,
                label: t('budget.scenarioOption', {
                  name: scenario.name,
                  year: scenario.fiscalYear,
                  status: tb(`status.${scenario.status}`),
                }),
              })),
            }}
            dimensions={dimensions}
            actions={
              <>
                {manageAction}
                <SaveViewButton />
                <ExportMenu kind="budget" params={{ ...sp, scenario: scenarioId }} />
              </>
            }
          />
        </>
      }
    >
      <ReportPaper
        company={org?.name ?? ''}
        title={t('budget.title')}
        periodPhrase={scenarios.find((scenario) => scenario.id === scenarioId)?.name}
        wide={(view?.columns.length ?? 0) > 4}
      >
        {view ? (
          <StatementMatrixTable
            view={view}
            currency={org?.base_currency}
            drill={{ dims: q.dims, basis: 'accrual', budgetScenarioId: scenarioId }}
          />
        ) : (
          <p className="py-8 text-center text-slate-400 italic">{t('budget.noScenarios')}</p>
        )}
      </ReportPaper>
    </ListPageLayout>
  )
}
