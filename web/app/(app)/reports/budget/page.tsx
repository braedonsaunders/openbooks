import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { budgetScenarioOptions, budgetVsActualView } from '../../../../lib/budget-report'
import { StatementMatrixTable } from '../StatementMatrixTable'
import { ScenarioPicker } from './ScenarioPicker'
import { SaveViewButton } from '../SaveViewButton'
import { StatementExport } from '../StatementExport'

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
            description={t('budget.description')}
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
  const view = await budgetVsActualView(scenarioId, labels)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('budget.title')}
            description={t('budget.description')}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="budget" params={{ scenario: scenarioId }} /></>}
          />
          <ScenarioPicker scenarios={scenarios} value={scenarioId} />
        </>
      }
    >
      {view ? (
        <StatementMatrixTable view={view} />
      ) : (
        <p className="py-8 text-center text-slate-400 italic">{t('budget.noScenarios')}</p>
      )}
    </ListPageLayout>
  )
}
