import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock } from '@braedonsaunders/appkit-viewspec'
import { readAnalyticsDashboard } from '../../../../lib/analytics/dashboard-reader'
import { CollectionPeriodError } from '../../../../lib/analytics/receivables-metrics'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { receivablesIntelligenceSpec } from './view'

export const dynamic = 'force-dynamic'
export async function generateMetadata() {
  return { title: (await getTranslations('analytics.receivables'))('title') }
}
export default async function ReceivablesIntelligencePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  let result: { data: Parameters<typeof receivablesIntelligenceSpec>[0] } | { error: CollectionPeriodError }
  try {
    result = { data: await readAnalyticsDashboard('receivables-intelligence', sp, { answerStale: true }) }
  } catch (error) {
    if (!(error instanceof CollectionPeriodError)) throw error
    result = { error }
  }
  if ('error' in result) {
    const t = await getTranslations('analytics.receivables')
    return <ModuleView spec={page({ route: '/analytics/receivables-intelligence', layout: 'list',
      header: [frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: t('title'), periodLabel: '', backLabel: t('backToHub'),
      })],
      body: [widgetBlock('app-notice', { title: t('title'), description: result.error.message,
        backHref: '/analytics', backLabel: t('backToHub') })],
    })} data={{}} searchParams={sp} trusted />
  }
  return <ModuleView spec={receivablesIntelligenceSpec(result.data)} data={result.data} searchParams={sp} trusted />
}
