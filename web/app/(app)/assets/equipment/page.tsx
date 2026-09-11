import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadEquipmentPage, equipmentSpec } from './view'

export const dynamic = 'force-dynamic'
export default async function EquipmentPage({ searchParams }: { searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const sp = await searchParams
  const data = await loadEquipmentPage(sp)
  return <ModuleView spec={equipmentSpec(data)} data={data} searchParams={sp} trusted />
}
