import { ModuleView } from '../../../components/viewspec/module-view'
import { loadSalesOrders, salesOrdersSpec } from './view'

export const dynamic = 'force-dynamic'


/**
 * Sales orders. The list is the universal RecordListView; this page owns the
 * header, the New button, and the OrderDrawer flyout. Order→invoice conversion
 * is reported in /reports/conversion, not on the list.
 */
export default async function SalesOrders({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSalesOrders(sp)
  return <ModuleView spec={salesOrdersSpec(data)} data={data} searchParams={sp} trusted />
}
