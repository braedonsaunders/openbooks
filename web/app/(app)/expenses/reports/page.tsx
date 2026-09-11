import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadExpenseReports, expenseReportsSpec } from './view'

export const dynamic = 'force-dynamic'

/** Expense reports use the universal documents list; this route owns the
 * create action and the expense-specific editor payload only. */
export default async function Expenses({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('expenses.read')
  await requireFeatureEnabled(authz.user.orgId, 'expenses')
  const sp = await searchParams
  const data = await loadExpenseReports(sp)
  return <ModuleView spec={expenseReportsSpec(data)} data={data} searchParams={sp} trusted />
}
