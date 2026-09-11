import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadApiDocs, apiDocsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('apiDocs')
  return { title: t('metaTitle') }
}

export default async function ApiDocsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadApiDocs(sp)
  return <ModuleView spec={apiDocsSpec(data)} data={data} searchParams={sp} trusted />
}
