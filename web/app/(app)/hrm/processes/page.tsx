import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadProcessesRoute, processesSpec, processesTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await processesTitle() }
}

/**
 * Process checklists — employment starts, ends, and transfers with owners,
 * due dates, and evidence. Renders only when the hrm feature gate is on
 * and the actor holds hrm.process.read — the view 404s otherwise.
 */
export default async function ProcessesPage() {
  const data = await loadProcessesRoute()
  return <ModuleView spec={processesSpec(data)} data={data} searchParams={{}} trusted />
}
