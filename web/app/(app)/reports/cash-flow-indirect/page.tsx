import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCashFlowIndirect, cashFlowIndirectSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function CashFlowIndirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCashFlowIndirect(sp)
  return <ModuleView spec={cashFlowIndirectSpec(data)} data={data} searchParams={sp} trusted />
}






