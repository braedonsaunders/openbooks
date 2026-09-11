import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadContinuousClose, continuousCloseSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('continuousClose')
  return { title: t('metaTitle') }
}




export default async function ContinuousClosePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadContinuousClose(sp)
  return <ModuleView spec={continuousCloseSpec(data)} data={data} searchParams={sp} trusted />
}

