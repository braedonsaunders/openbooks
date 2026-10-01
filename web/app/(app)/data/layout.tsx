import { type ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getAuthz } from '../../../lib/authz'
import { dataWorkspaceNavigation } from '../../../lib/setup/data-workspace'
import { SetupWorkspace } from '../admin/setup/SetupWorkspace'

export const dynamic = 'force-dynamic'

export default async function DataLayout({ children }: { children: ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  // Data-only roles retain access; each page enforces its own import/export grant.
  if (!dataWorkspaceNavigation(authz.permissions).showSetup) return children
  return <SetupWorkspace authz={authz} contentLayout="section">{children}</SetupWorkspace>
}
