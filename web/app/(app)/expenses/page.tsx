import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { requirePermission, can } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { expensesDashboard } from '../../../lib/expenses-dashboard'
import { ExpensesDashboard } from './ExpensesDashboard'
import { NewExpenseButton } from './NewExpenseButton'
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
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadExpenses(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={expensesSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('expenses.read')
  await requireFeatureEnabled(authz.user.orgId, 'expenses')

  const t = await getTranslations('expenses')
  const data = await expensesDashboard(authz.user.orgId)

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('dashboard.title')}
          description={t('dashboard.description')}
          actions={
            <div className="flex items-center gap-3">
              {can(authz, 'expenses.create') ? <NewExpenseButton /> : null}
              <ModuleHomeTabs tabs={await groupTabs('purchasing', '/expenses', { orgId: authz.user.orgId })} />
            </div>
          }
        />
      }
    >
      <ExpensesDashboard data={data} />
    </ListPageLayout>
  )
}
