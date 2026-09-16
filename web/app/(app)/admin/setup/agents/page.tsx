import { ModuleView } from '../../../../../components/viewspec/module-view'
import { agentsOverviewSpec, loadAgentsOverview } from './view'

export const dynamic = 'force-dynamic'

/**
 * Setup → Agents → Overview. Every background agent pack in one place:
 * enable/disable, cadence, last run, open findings, run-now, policy links.
 * Pack configuration moved here from the AI provider page so provider
 * credentials and agent policy stop sharing a form.
 */
export default async function AgentsOverviewSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAgentsOverview(sp)
  return <ModuleView spec={agentsOverviewSpec(data)} data={data} searchParams={sp} trusted />
}
