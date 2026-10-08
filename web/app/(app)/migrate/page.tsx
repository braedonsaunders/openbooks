import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadMigrationWorkspace, migrationWorkspaceSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('sync.migrationAssistant')
  return { title: t('title') }
}

/** The migration workspace with a new conversation. */
export default async function MigrationWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMigrationWorkspace(sp)
  return <ModuleView spec={migrationWorkspaceSpec(data)} data={data} searchParams={sp} trusted />
}
