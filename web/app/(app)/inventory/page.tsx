import { ModuleView } from '../../../components/viewspec/module-view'
import { loadInventory, inventorySpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Inventory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadInventory(sp)
  return <ModuleView spec={inventorySpec(data)} data={data} searchParams={sp} trusted />
}
