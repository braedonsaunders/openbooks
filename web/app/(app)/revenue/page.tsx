import { ModuleView } from '../../../components/viewspec/module-view'
import { loadRevenue, revenueSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Revenue({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRevenue(sp)
  return <ModuleView spec={revenueSpec(data)} data={data} searchParams={sp} trusted />
}
