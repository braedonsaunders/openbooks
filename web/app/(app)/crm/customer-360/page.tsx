import { ModuleView } from '../../../../components/viewspec/module-view'
import { customer360Spec, loadCustomer360View } from './view'

export const dynamic = 'force-dynamic'

export default async function Customer360Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomer360View(sp)
  return <ModuleView spec={customer360Spec(data)} data={data} searchParams={sp} trusted />
}
