import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadImportHistory, importHistorySpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ImportHistoryPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadImportHistory()
  return <ModuleView spec={importHistorySpec()} data={data} searchParams={sp} trusted />
}
