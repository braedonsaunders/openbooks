import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadExpenses, expensesSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('expenses')
  return { title: t('dashboard.title') }
}

/**
 * Expense-reports dashboard — the purchasing group's expenses cockpit (a
 * strip tab beside Purchasing and Accounts Payable). The report list lives at
 * /expenses/reports and is reached from the menu.
 */
export default async function ExpensesHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadExpenses(sp)
  return <ModuleView spec={expensesSpec(data)} data={data} searchParams={sp} trusted />
}
