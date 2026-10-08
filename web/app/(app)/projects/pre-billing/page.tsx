import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPreBilling, preBillingSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function PreBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPreBilling(sp)
  return <ModuleView spec={preBillingSpec(data)} data={data} searchParams={sp} trusted />
}
