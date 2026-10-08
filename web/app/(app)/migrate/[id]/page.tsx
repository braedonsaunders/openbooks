import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMigrationConversation, migrationConversationSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('sync.migrationAssistant')
  return { title: t('title') }
}

/** One deep-linkable migration conversation. */
export default async function MigrationConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadMigrationConversation(id)
  return <ModuleView spec={migrationConversationSpec(data)} data={data} searchParams={sp} trusted />
}
