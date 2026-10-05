import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPlanning, planningSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Inventory planning: the week's buy-or-move work queue. Forecasts per item
 * and location become reviewable suggestions; the header runs the plan,
 * confirms everything suggested, and turns confirmed purchases into
 * purchase orders grouped by supplier.
 */
export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPlanning(sp)
  return <ModuleView spec={planningSpec(data)} data={data} searchParams={sp} trusted />
}
