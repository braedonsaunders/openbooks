import { readAnalyticsDashboard } from '../../../../lib/analytics/dashboard-reader'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { vendorPerformanceSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.vendor')
  return { title: t('title') }
}

export default async function VendorPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await readAnalyticsDashboard('vendor-performance', sp)
  return <ModuleView spec={vendorPerformanceSpec(data)} data={data} searchParams={sp} trusted />
}
