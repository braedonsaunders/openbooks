import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPageLayouts, pageLayoutsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.pageLayouts')
  return { title: t('title') }
}

export default async function PageLayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPageLayouts(sp)
  return <ModuleView spec={pageLayoutsSpec(data)} data={data} searchParams={sp} trusted />
}
