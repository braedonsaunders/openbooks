import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadFlows, flowsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.flows')
  return { title: t('title') }
}


export default async function Flows({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadFlows(sp)
  return <ModuleView spec={flowsSpec(data)} data={data} searchParams={sp} trusted />
}
