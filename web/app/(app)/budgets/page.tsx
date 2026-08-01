import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, parsePrefixedListParams, pickString } from '../../../lib/list-params'
import { loadBudgetBooksAndYears, loadBudgetWorkspace, type BudgetDimensions } from '../../../lib/budgets'
import { NewBudgetButton } from './NewBudgetButton'
import { BudgetDrawer } from './BudgetDrawer'

export const dynamic = 'force-dynamic'

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = await getTranslations('budgets')
  const authz = await requirePermission('budgets.read')
  const orgId = authz.user.orgId
  const canManage = can(authz, 'budgets.manage')
  const sp = await searchParams
  const budgetId = pickString(sp.budget)
  const budgetList = parsePrefixedListParams(sp, 'budget', { sort: 'account', dir: 'asc', perPage: 50, allowedSorts: ['account'] as const })
  const dimension = (key: string) => {
    const value = pickString(sp[key])
    return value && isUuid(value) ? value : null
  }
  const dims: BudgetDimensions = {
    departmentId: dimension('budgetDepartment'),
    projectId: dimension('budgetProject'),
    locationId: dimension('budgetLocation'),
    classId: dimension('budgetClass'),
  }
  const { books, years } = await loadBudgetBooksAndYears(orgId)
  const [sources, workspace] = await Promise.all([
    budgetId && isUuid(budgetId) ? db.execute(sql`
      select id, name, fiscal_year from budget_scenarios
       where org_id = ${orgId} and status <> 'archived' order by updated_at desc limit 50
    `) as Promise<{ rows: { id: string; name: string; fiscal_year: number }[] }> : Promise.resolve({ rows: [] }),
    budgetId && isUuid(budgetId) ? loadBudgetWorkspace(budgetId, orgId, {
      q: budgetList.q,
      page: budgetList.page,
      perPage: budgetList.perPage,
      dims,
    }) : Promise.resolve(null),
  ])
  const requestedReturn = pickString(sp.drawerReturn)
  const closeHref = requestedReturn?.startsWith('/budgets') ? requestedReturn : mergeHref('/budgets', sp, {
    budget: null,
    budgetNew: null,
    budgetQ: null,
    budgetPage: null,
    budgetDepartment: null,
    budgetProject: null,
    budgetLocation: null,
    budgetClass: null,
    budgetImport: null,
    budgetView: null,
    drawerReturn: null,
  })

  return (
    <ListPageLayout header={<PageHeader title={t('list.title')} description={t('list.description')} actions={canManage ? <NewBudgetButton currentParams={sp} /> : undefined} />}>
      <EntityListView
        recordType="budget_scenario"
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        emptyAction={canManage ? <NewBudgetButton currentParams={sp} /> : undefined}
        drawer={workspace ? <BudgetDrawer
          key={`${workspace.scenario.id}-${workspace.scenario.revision}-${dims.departmentId}-${dims.projectId}-${dims.locationId}-${dims.classId}`}
          initial={workspace}
          currentParams={sp}
          dims={dims}
          closeHref={closeHref}
          books={books}
          years={years}
          sources={sources.rows}
          newlyCreated={pickString(sp.budgetNew) === '1'}
          canManage={canManage}
          canApprove={can(authz, 'budgets.approve')}
          canExport={can(authz, 'data.export')}
        /> : null}
      />
    </ListPageLayout>
  )
}
