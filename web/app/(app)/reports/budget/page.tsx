import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { budgetScenarioOptions, budgetVsActualView } from '../../../../lib/budget-report'
import { orgInfo } from '../../../../lib/data'
import { StatementMatrixTable } from '../StatementMatrixTable'
import { ScenarioPicker } from './ScenarioPicker'
import { SaveViewButton } from '../SaveViewButton'
import { ExportMenu } from '../ExportMenu'

export const dynamic = 'force-dynamic'

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const sp = await searchParams
  const scenarios = await budgetScenarioOptions()

  if (scenarios.length === 0) {
    return (
      <ListPageLayout
        header={
          <PageHeader
            title={t('budget.title')}
            back={{ href: '/reports', label: t('hub.title') }}
          />
        }
      >
        <p className="py-8 text-center text-slate-400 italic">{t('budget.noScenarios')}</p>
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
  const [view, org] = await Promise.all([budgetVsActualView(scenarioId, labels), orgInfo()])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('budget.title')}
            back={{ href: '/reports', label: t('hub.title') }}
          />
          <div className="flex items-end justify-between gap-2">
            <ScenarioPicker scenarios={scenarios} value={scenarioId} />
            <div className="flex items-center gap-1.5">
              <SaveViewButton />
              <ExportMenu kind="budget" params={{ scenario: scenarioId }} />
            </div>
          </div>
        </>
      }
    >
      {view ? (
        <StatementMatrixTable
          view={view}
          currency={org?.base_currency}
          drill={{ dims: {}, basis: 'accrual', back: `/reports/budget?scenario=${scenarioId}`, backLabel: t('budget.title') }}
        />
      ) : (
        <p className="py-8 text-center text-slate-400 italic">{t('budget.noScenarios')}</p>
      )}
    </ListPageLayout>
  )
}
