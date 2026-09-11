import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAppsLibrary, appsLibrarySpec } from './view'

export const runtime = 'nodejs'

export default async function AppLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAppsLibrary(sp)
  return <ModuleView spec={appsLibrarySpec(data)} data={data} searchParams={sp} trusted />
}
