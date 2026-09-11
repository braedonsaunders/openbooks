import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadTrash, trashSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('documents.trash')
  return { title: t('title') }
}

export default async function TrashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadTrash()
  return <ModuleView spec={trashSpec(data)} data={data} searchParams={sp} trusted />
}
