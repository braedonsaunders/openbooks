import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadUtilization, utilizationSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.utilization')
  return { title: t('title') }
}

export default async function UtilizationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadUtilization(sp)
  return <ModuleView spec={utilizationSpec(data)} data={data} searchParams={sp} trusted />
}
