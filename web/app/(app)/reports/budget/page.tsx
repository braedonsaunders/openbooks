import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadBudgetReport, budgetReportSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp0 = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('budget', sp0)
  const data = await loadBudgetReport(sp0)
  return <ModuleView spec={budgetReportSpec(data)} data={data} searchParams={sp0} trusted />
}
