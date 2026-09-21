import { ModuleView } from '../../../../components/viewspec/module-view'
import { crewSpec, crewTitle, loadCrewPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await crewTitle() }
}

/**
 * The foreman crew page — batches per project per day with the batch
 * drawer. Renders for time readers and foremen when
 * fieldTimeCrewEntry is on — the view 404s otherwise.
 */
export default async function CrewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCrewPage(sp)
  return <ModuleView spec={crewSpec(data, '/time/crew')} data={data} searchParams={sp} trusted />
}
