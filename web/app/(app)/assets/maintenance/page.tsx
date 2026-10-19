import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMaintenance } from './_data'
import { maintenanceSpec } from './view'

export const dynamic = 'force-dynamic'

/** Asset maintenance: the due and overdue queue, schedules and work records. */
export default async function AssetMaintenancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMaintenance(sp)
  return <ModuleView spec={maintenanceSpec(data)} data={data} searchParams={sp} trusted />
}
