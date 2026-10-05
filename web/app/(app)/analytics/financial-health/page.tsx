import { readAnalyticsDashboard } from '../../../../lib/analytics/dashboard-reader'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { financialHealthSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.financialHealth')
  return { title: t('title') }
}

export default async function FinancialHealthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await readAnalyticsDashboard('financial-health', sp)
  return <ModuleView spec={financialHealthSpec(data)} data={data} searchParams={sp} trusted />
}
