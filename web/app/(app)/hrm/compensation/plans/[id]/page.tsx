import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { compPlanSpec, compPlanTitle, loadCompPlanPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return { title: await compPlanTitle(id) }
}

/**
 * One headcount plan — costed lines with the total, approve opens
 * requisitions through the recruiting service. Renders only when
 * hrmHeadcountPlans is on and the actor holds hrm.compensation.read.
 */
export default async function CompPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { id } = await params
  const sp = await searchParams
  const data = await loadCompPlanPage(id)
  return <ModuleView spec={compPlanSpec(data)} data={data} searchParams={sp} trusted />
}
