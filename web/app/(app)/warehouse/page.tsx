import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadWarehouse, warehouseSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('warehouse')
  return { title: t('home.title') }
}

/**
 * Warehouse module home: on-hand value by warehouse tied out to the inventory
 * control accounts, stock awaiting putaway, and the warehouse and putaway-rule
 * setup. The loader refuses with the Features-page remedy while Warehousing
 * is off.
 */
export default async function WarehouseHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const spec = await searchParams
  const data = await loadWarehouse(spec)
  return <ModuleView spec={warehouseSpec(data)} data={data} searchParams={spec} trusted />
}
