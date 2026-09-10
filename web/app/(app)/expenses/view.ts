import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { expensesDashboard, type ExpensesDashboardData } from '../../../lib/expenses-dashboard'

/**
 * Expense-reports dashboard — the purchasing group's expenses cockpit (a
 * strip tab beside Purchasing and Accounts Payable), split into a loader and
 * a spec.
 *
 * This follows the ar-cockpit archetype, not a list page: the body is one
 * client cockpit (KPI vitals, client-state sub-tabs, echarts trend, approval
 * queue, top-spender and category tables, drill drawer) that stays whole
 * behind ONE widget. The spec places the header and the cockpit; the loader
 * performs the page's server work (the expenses.read gate, the expenses
 * feature gate, the dashboard queries via expensesDashboard, the
 * module-home tabs — the purchasing-tabs pattern from ar/view.ts).
 *
 * The data contract is the ExpensesDashboardData the native page already
 * passes to <ExpensesDashboard data={data}>, verbatim — the widget renders
 * the shared component over it, so neither render path can drift. Money,
 * dates and percentages stay raw canonical strings/numbers: the cockpit is
 * a client component whose useMoney compact formatter owns presentation,
 * exactly as it does natively.
 *
 * No sections.tsx: there is no per-row composite cell to share. The dashboard
 * has no rows in the spec sense — its tables live inside the cockpit.
 */

export interface ExpensesData {
  title: string
  description: string
  canCreate: boolean
  tabs: unknown
  data: ExpensesDashboardData
}

export async function loadExpenses(
  _sp: Record<string, string | string[] | undefined>,
): Promise<ExpensesData> {
  const authz = await requirePermission('expenses.read')
  await requireFeatureEnabled(authz.user.orgId, 'expenses')
  const t = await getTranslations('expenses')

  return {
    title: t('dashboard.title'),
    description: t('dashboard.description'),
    canCreate: can(authz, 'expenses.create'),
    tabs: await groupTabs('purchasing', '/expenses', { orgId: authz.user.orgId }),
    data: await expensesDashboard(authz.user.orgId),
  }
}

const f = ref<ExpensesData>()

export function expensesSpec(data: ExpensesData): PageSpec {
  return page({
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget('new-expense', {}, f('canCreate')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      // The whole cockpit — vitals, sub-tabs, trend, queue, tables, drill
      // drawer — stays one client component. A widget, not a slot: the loader
      // holds no user capability the host side must re-derive (authz is
      // checked in the loader before the data is built), and the drawer/drill
      // fetches ride the session cookie inside the shared component.
      widgetBlock('expenses-dashboard', { data: data.data }),
    ],
  })
}
