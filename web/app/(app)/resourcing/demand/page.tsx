import { ModuleView } from '../../../../components/viewspec/module-view'
import { demandSpec, loadDemandPage } from './view'

export const dynamic = 'force-dynamic'

export default async function DemandPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDemandPage(sp)
  return <ModuleView spec={demandSpec(data)} data={data} searchParams={sp} trusted />
}
