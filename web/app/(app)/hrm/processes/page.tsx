import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadProcessesRoute, processesSpec, processesTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await processesTitle() }
}

/**
 * Process checklists — employment starts, ends, and transfers with owners,
 * due dates, and evidence. Segments filter server-side; a row opens the
 * checklist drawer through the URL. Renders only when the hrm feature gate
 * is on and the actor holds hrm.process.read — the view 404s otherwise.
 */
export default async function ProcessesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadProcessesRoute(sp)
  return <ModuleView spec={processesSpec(data)} data={data} searchParams={sp} trusted />
}
