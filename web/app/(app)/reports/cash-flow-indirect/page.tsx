import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadCashFlowIndirect, cashFlowIndirectSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function CashFlowIndirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('cash-flow-indirect', sp)
  const data = await loadCashFlowIndirect(sp)
  return <ModuleView spec={cashFlowIndirectSpec(data)} data={data} searchParams={sp} trusted />
}






