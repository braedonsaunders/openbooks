import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBuildHub, buildHubSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin')
  return { title: t('buildHub.metaTitle') }
}



export default async function BuildPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBuildHub()
  return <ModuleView spec={buildHubSpec(data)} data={data} searchParams={sp} trusted />
}
