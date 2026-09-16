import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { agentPolicySpec, loadAgentPolicy } from './view'

export const dynamic = 'force-dynamic'

/**
 * Setup → Agents → one pack's policy. Detectors, thresholds, materiality,
 * cadence, analysis tier and finding routing — the configuration the provider
 * page's drawer used to own, now a first-party page per pack.
 */
export default async function AgentPolicySetup({
  params,
  searchParams,
}: {
  params: Promise<{ agentKey: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { agentKey } = await params
  const sp = await searchParams
  const data = await loadAgentPolicy(agentKey)
  return <ModuleView spec={agentPolicySpec(data)} data={data} searchParams={sp} trusted />
}
