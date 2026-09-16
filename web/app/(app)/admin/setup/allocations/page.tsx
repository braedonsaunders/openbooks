import { ModuleView } from '../../../../../components/viewspec/module-view'
import { allocationsSpec, loadAllocations } from './view'

export const dynamic = 'force-dynamic'

export default async function AllocationsSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAllocations(sp)
  return <ModuleView spec={allocationsSpec(data)} data={data} searchParams={sp} trusted />
}
