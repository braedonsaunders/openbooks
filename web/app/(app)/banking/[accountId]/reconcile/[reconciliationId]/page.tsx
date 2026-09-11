import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { loadReconciliation, reconcileSpec } from './view'

export const dynamic = 'force-dynamic'






export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string; reconciliationId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { accountId, reconciliationId } = await params
  const data = await loadReconciliation(accountId, reconciliationId, sp)
  return <ModuleView spec={reconcileSpec(data)} data={data} searchParams={sp} trusted />
}
