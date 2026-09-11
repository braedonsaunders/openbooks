import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadTrueCost, trueCostSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function TrueCostReport({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadTrueCost(sp)
  return <ModuleView spec={trueCostSpec(data)} data={data} searchParams={sp} trusted />
}
