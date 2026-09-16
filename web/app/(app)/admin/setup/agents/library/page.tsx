import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { agentsLibrarySpec, loadAgentsLibrary } from './view'

export const dynamic = 'force-dynamic'

/**
 * Setup → Agents → Library. The installable catalog: every pack, what it
 * reads and proposes, what it needs, and its checks — with install/enable
 * from here.
 */
export default async function AgentsLibrarySetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAgentsLibrary()
  return <ModuleView spec={agentsLibrarySpec(data)} data={data} searchParams={sp} trusted />
}
