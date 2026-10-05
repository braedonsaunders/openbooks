import { type ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { can, getAuthz } from '../../../../lib/authz'
import { accessDeniedHref } from '../../../../lib/gate-targets'
import { SetupWorkspace } from './SetupWorkspace'

export const dynamic = 'force-dynamic'

export default async function SetupLayout({ children }: { children: ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  // Setup is available to company administrators and authorized domain setup managers.
  if (!can(authz, 'admin.setup.manage') && !can(authz, 'crm.setup.manage') && !can(authz, 'hrm.performance.manage') && !can(authz, 'hrm.compensation.manage') && !can(authz, 'payroll.read')) {
    redirect(accessDeniedHref({ permission: 'admin.setup.manage' }))
  }
  return <SetupWorkspace authz={authz}>{children}</SetupWorkspace>
}
