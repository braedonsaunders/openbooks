import { ModuleView } from '../../../components/viewspec/module-view'
import { loadSchedulingPage, schedulingSpec, schedulingTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await schedulingTitle() }
}

/**
 * Scheduling — every people and task board in one workspace. Renders when
 * Scheduling or Project Scheduling is on and the actor can read the board
 * family; otherwise the page 404s or explains the missing permission.
 */
export default async function SchedulingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSchedulingPage(sp)
  return <ModuleView spec={schedulingSpec(data)} data={data} searchParams={sp} trusted />
}
