import { ModuleView } from '../../../components/viewspec/module-view'
import { loadInsights, insightsSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function InsightsCards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadInsights(sp)
  return <ModuleView spec={insightsSpec(data)} data={data} searchParams={sp} trusted />
}
