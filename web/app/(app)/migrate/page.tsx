import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadMigrationCutover, migrationCutoverSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('sync.migrationAssistant')
  return { title: t('cutover.title') }
}

/** The guided migration cutover: every path works through this checklist, with or without the assistant. */
export default async function MigrationCutoverPage() {
  const data = await loadMigrationCutover()
  return <ModuleView spec={migrationCutoverSpec(data)} data={data} searchParams={{}} trusted />
}
