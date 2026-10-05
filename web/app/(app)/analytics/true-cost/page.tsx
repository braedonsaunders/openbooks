import { readAnalyticsDashboard } from '../../../../lib/analytics/dashboard-reader'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { trueCostSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.trueCost')
  return { title: t('title') }
}

export default async function TrueCostPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await readAnalyticsDashboard('true-cost', sp)
  return <ModuleView spec={trueCostSpec(data)} data={data} searchParams={sp} trusted />
}
