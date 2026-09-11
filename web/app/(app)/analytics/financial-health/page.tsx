import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadFinancialHealth, financialHealthSpec } from './view'
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
  const data = await loadFinancialHealth(sp)
  return <ModuleView spec={financialHealthSpec(data)} data={data} searchParams={sp} trusted />
}
