import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadDocuments, documentsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('documents')
  return { title: t('list.metaTitle') }
}


/** Build a /documents href that navigates to a folder, preserving sort/search. */

export default async function Documents({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDocuments(sp)
  return <ModuleView spec={documentsSpec(data)} data={data} searchParams={sp} trusted />
}
