import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCashFlow, cashFlowSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function CashFlow({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCashFlow(sp)
  return <ModuleView spec={cashFlowSpec(data)} data={data} searchParams={sp} trusted />
}

