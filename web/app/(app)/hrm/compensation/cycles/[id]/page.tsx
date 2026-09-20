import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { compCycleSpec, compCycleTitle, loadCompCyclePage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return { title: await compCycleTitle(id) }
}

/**
 * One merit cycle — the team grid with the pacing bar, department
 * filter chips, and the per-line drawer. Renders only when
 * hrmMeritCycles is on and the actor holds hrm.compensation.read.
 */
export default async function CompCyclePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { id } = await params
  const sp = await searchParams
  const data = await loadCompCyclePage(id, sp)
  return <ModuleView spec={compCycleSpec(data)} data={data} searchParams={sp} trusted />
}
