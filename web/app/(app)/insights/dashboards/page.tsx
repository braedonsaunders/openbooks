import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadDashboards, dashboardsSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function InsightsDashboards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDashboards(sp)
  return <ModuleView spec={dashboardsSpec(data)} data={data} searchParams={sp} trusted />
}
