import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadTrueCostPlanner, trueCostPlannerSpec } from './view'

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
  const data = await loadTrueCostPlanner(sp)
  return <ModuleView spec={trueCostPlannerSpec(data)} data={data} searchParams={sp} trusted />
}
