import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPayrollOpeningBalances, payrollOpeningBalancesSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Mid-year adoption: the statutory year-to-date each employee brings in from
 * the employer's previous payroll system.
 *
 * This lives in the PAYROLL module rather than on the /admin/setup rail on
 * purpose. It is not org configuration — it is per-employee compensation data
 * with its own lifecycle (immutable once a run commits for that employee and
 * year), gated on payroll's own permissions, and loaded as a whole workforce
 * at adoption. The Setup registry expresses none of those three things: its
 * generic API is gated on `admin.setup.manage`, its drawer edits one record at
 * a time, and it has no per-row immutability hook.
 */
export default async function PayrollOpeningBalancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayrollOpeningBalances(sp)
  return <ModuleView spec={payrollOpeningBalancesSpec(data)} data={data} searchParams={sp} trusted />
}
