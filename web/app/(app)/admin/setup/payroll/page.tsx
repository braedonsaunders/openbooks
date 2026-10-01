import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPayrollSetup, payrollSetupSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Payroll setup uses a family selector and one local route strip. Historical
 * query-tab links remain supported by the loader, including country aliases.
 */
export default async function PayrollSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayrollSetup(sp)
  return <ModuleView spec={payrollSetupSpec(data)} data={data} searchParams={sp} trusted />
}
