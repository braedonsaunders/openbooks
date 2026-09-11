import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadSentinel, sentinelSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.sentinel')
  return { title: t('title') }
}

export default async function SentinelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSentinel(sp)
  return <ModuleView spec={sentinelSpec(data)} data={data} searchParams={sp} trusted />
}
