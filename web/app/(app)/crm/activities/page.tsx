import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadActivities, activitiesSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Activities({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadActivities(sp)
  return <ModuleView spec={activitiesSpec(data)} data={data} searchParams={sp} trusted />
}
