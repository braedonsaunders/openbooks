import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadBalanceSheet, balanceSheetSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function BalanceSheet({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp0 = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('balance-sheet', sp0)
  const data = await loadBalanceSheet(sp0)
  return <ModuleView spec={balanceSheetSpec(data)} data={data} searchParams={sp0} trusted />
}
