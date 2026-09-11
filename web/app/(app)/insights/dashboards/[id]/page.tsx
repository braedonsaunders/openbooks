import { ModuleView } from '../../../../../components/viewspec/module-view'
import { insightsDashboardSpec, loadInsightsDashboard } from './view'

export const dynamic = 'force-dynamic'

export default async function DashboardDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const { id } = await params
  const data = await loadInsightsDashboard(id)
  return <ModuleView spec={insightsDashboardSpec(data)} data={data} searchParams={sp} trusted />
}
