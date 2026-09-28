import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadResourcing, resourcingSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('resourcing.cockpit')
  return { title: t('title') }
}

/**
 * Resourcing module home — the staffing workspace landing the nav entry
 * opens. The vitals strip carries capacity, bench, rolloffs and
 * overallocation beside the formula utilization total; the plan-vs-actual
 * tie-out below drills every figure to its evidence. Tabs are routes shared
 * with every page in the group.
 */
export default async function ResourcingHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const spec = await searchParams
  const data = await loadResourcing(spec)
  return <ModuleView spec={resourcingSpec(data)} data={data} searchParams={spec} trusted />
}
