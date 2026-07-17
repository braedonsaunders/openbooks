import { notFound } from 'next/navigation'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../../lib/list-params'
import { loadBudgetWorkspace, type BudgetDimensions } from '../../../../lib/budgets'
import { BudgetScreen } from './BudgetScreen'

export const dynamic = 'force-dynamic'

export default async function BudgetWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('budgets.read')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const sp = await searchParams
  const list = parseListParams(sp, { sort: 'account', dir: 'asc', perPage: 50, allowedSorts: ['account'] as const })
  const dimension = (key: string) => {
    const value = pickString(sp[key])
    return value && isUuid(value) ? value : null
  }
  const dims: BudgetDimensions = {
    departmentId: dimension('department'),
    projectId: dimension('project'),
    locationId: dimension('location'),
    classId: dimension('class'),
  }
  const workspace = await loadBudgetWorkspace(id, authz.user.orgId, {
    q: list.q,
    page: list.page,
    perPage: list.perPage,
    dims,
  })
  if (!workspace) notFound()
  return <BudgetScreen
    key={`${workspace.scenario.id}-${workspace.scenario.revision}-${dims.departmentId}-${dims.projectId}-${dims.locationId}-${dims.classId}`}
    initial={workspace}
    currentParams={sp}
    dims={dims}
    canManage={can(authz, 'budgets.manage')}
    canApprove={can(authz, 'budgets.approve')}
    canExport={can(authz, 'data.export')}
  />
}
