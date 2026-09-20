import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPositionsPage, positionsSpec, positionsTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await positionsTitle() }
}

/**
 * Positions tab: the funded establishment as of a date with vacancy per
 * position. Status segments filter server-side; a row opens the position
 * drawer (versions, funding by period, current holder) through the URL, so
 * the selection is shareable and the drawer closes by navigation. Renders
 * only when the hrm feature gate is on and the actor holds
 * hrm.position.read — the loader 404s otherwise.
 */
export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPositionsPage(sp)
  return <ModuleView spec={positionsSpec(data)} data={data} searchParams={sp} trusted />
}
