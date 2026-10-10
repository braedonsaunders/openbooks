import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadCashFlow, cashFlowSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function CashFlow({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('cash-flow', sp)
  const data = await loadCashFlow(sp)
  return <ModuleView spec={cashFlowSpec(data)} data={data} searchParams={sp} trusted />
}

