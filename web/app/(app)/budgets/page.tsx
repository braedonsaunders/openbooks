import { ModuleView } from '../../../components/viewspec/module-view'
import { loadBudgets, budgetsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadBudgets(sp)
  return <ModuleView spec={budgetsSpec(data)} data={data} searchParams={sp} trusted />
}
