import { getTranslations } from 'next-intl/server'
import { readAnalyticsDashboard } from '../../../../lib/analytics/dashboard-reader'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { receivablesIntelligenceSpec } from './view'

export const dynamic = 'force-dynamic'
export async function generateMetadata() {
  return { title: (await getTranslations('analytics.receivables'))('title') }
}
export default async function ReceivablesIntelligencePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const data = await readAnalyticsDashboard('receivables-intelligence', sp)
  return <ModuleView spec={receivablesIntelligenceSpec(data)} data={data} searchParams={sp} trusted />
}
