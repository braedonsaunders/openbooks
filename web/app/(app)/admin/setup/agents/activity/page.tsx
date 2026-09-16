import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { agentsActivitySpec, loadAgentsActivity } from './view'

export const dynamic = 'force-dynamic'

/**
 * Setup → Agents → Activity. Runs across packs with status, duration,
 * findings and errors; re-run; link into findings.
 */
export default async function AgentsActivitySetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAgentsActivity()
  return <ModuleView spec={agentsActivitySpec(data)} data={data} searchParams={sp} trusted />
}
