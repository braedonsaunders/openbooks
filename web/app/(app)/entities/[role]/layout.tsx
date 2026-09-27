import type { ReactNode } from 'react'
import { can, getAuthz } from '../../../../lib/authz'
import { hrmViewTabGroups } from '../../../../lib/hrm/workspace-tabs'
import { ViewTabsProvider } from '../../../../components/module-home/view-tabs'

export const dynamic = 'force-dynamic'

/**
 * The employee list is the first view of the HRM Employees job, so it
 * gets the same view strip as its HRM siblings whenever the workspace
 * exists for this viewer (feature on plus the employment read grant).
 * Every other role list has no sibling views.
 */
export default async function EntityRoleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ role: string }>
}) {
  const { role } = await params
  if (role !== 'employees') return children
  const authz = await getAuthz()
  if (!authz || !can(authz, 'hrm.employment.read')) return children
  return <ViewTabsProvider groups={await hrmViewTabGroups(authz)}>{children}</ViewTabsProvider>
}
