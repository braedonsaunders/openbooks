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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={expenseReportsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
