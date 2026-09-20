import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeChecklistsPage, meChecklistsSpec, meChecklistsTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meChecklistsTitle() }
}

/**
 * Me checklists — my process steps with the complete action riding the
 * existing step endpoint. Renders only when the hrm feature gate is on
 * and the actor holds hrm.self.read — the view 404s otherwise.
 */
export default async function MeChecklistsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMeChecklistsPage()
  return <ModuleView spec={meChecklistsSpec(data)} data={data} searchParams={sp} trusted />
}
