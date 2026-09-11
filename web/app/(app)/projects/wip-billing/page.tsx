import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadWipBilling, wipBillingSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function WipBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadWipBilling(sp)
  return <ModuleView spec={wipBillingSpec(data)} data={data} searchParams={sp} trusted />
}
