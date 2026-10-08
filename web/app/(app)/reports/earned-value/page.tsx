import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { earnedValueSpec, loadEarnedValueReport } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('reports.earnedValue')
  return { title: t('title') }
}

/**
 * Earned value report: budget, percent complete, earned value, actual cost,
 * CPI and estimates per project and task as of a date. The loader redirects
 * to the Features remedy while Progress tracking is off.
 */
export default async function EarnedValueReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadEarnedValueReport(sp)
  return <ModuleView spec={earnedValueSpec(data)} data={data} searchParams={sp} trusted />
}
