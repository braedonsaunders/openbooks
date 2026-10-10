import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMigrationAssistant, migrationAssistantSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('sync.migrationAssistant')
  return { title: t('title') }
}

/** A new migration assistant conversation. */
export default async function MigrationAssistantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMigrationAssistant(sp)
  return <ModuleView spec={migrationAssistantSpec(data)} data={data} searchParams={sp} trusted />
}
