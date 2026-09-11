import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadSpendVelocity, spendVelocitySpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.spendVelocity')
  return { title: t('title') }
}

export default async function SpendVelocityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSpendVelocity(sp)
  return <ModuleView spec={spendVelocitySpec(data)} data={data} searchParams={sp} trusted />
}
