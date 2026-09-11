import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadLaborCosting, laborCostingSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Labor Costing — ONE workspace answering "what does an hour of labor cost?".
 * Wage rates (effective-dated, employee > job title > trade > department >
 * subsidiary > org default), the estimate
 * component calculator (statutory burden %, per-diem — inputs that die when
 * payroll actuals arrive), and the posting switch + control accounts.
 * Overhead is deliberately NOT here — that's the Overhead Model's job.
 */
// The view union stays here rather than moving into ./view.ts: the loader
// imports it, and a page that names its own tab set is the honest owner of it.
const VIEWS = ['rates', 'components', 'posting', 'reconciliation'] as const
export type LaborCostingView = (typeof VIEWS)[number]


export default async function LaborCostingSetup({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadLaborCosting(sp)
  return <ModuleView spec={laborCostingSpec(data)} data={data} searchParams={sp} trusted />
}
