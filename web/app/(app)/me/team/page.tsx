import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeTeamPage, meTeamSpec, meTeamTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meTeamTitle() }
}

/**
 * Me team — the manager's direct reports with their open steps, pending
 * leave, and pending change requests. Decisions ride native Approvals.
 * Renders only when the hrm feature gate is on and the actor holds
 * hrm.self.read; a report-less caller reads the refusal, never an empty
 * team.
 */
export default async function MeTeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMeTeamPage()
  return <ModuleView spec={meTeamSpec(data)} data={data} searchParams={sp} trusted />
}
