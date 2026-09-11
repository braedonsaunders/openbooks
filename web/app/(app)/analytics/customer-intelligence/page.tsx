import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomerIntelligence, customerIntelligenceSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.customer')
  return { title: t('title') }
}

export default async function CustomerIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomerIntelligence(sp)
  return <ModuleView spec={customerIntelligenceSpec(data)} data={data} searchParams={sp} trusted />
}
