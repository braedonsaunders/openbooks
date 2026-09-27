import type { ReactNode } from 'react'
import { getAuthz } from '../../../lib/authz'
import { hrmViewTabGroups } from '../../../lib/hrm/workspace-tabs'
import { ViewTabsProvider } from '../../../components/module-home/view-tabs'

export const dynamic = 'force-dynamic'

/**
 * The HRM view strips, resolved once for every page under /hrm. The page
 * layout renders the matching job's strip under each page header; pages
 * own their own access gates and never pass view tabs themselves.
 */
export default async function HrmLayout({ children }: { children: ReactNode }) {
  const authz = await getAuthz()
  if (!authz) return children
  return <ViewTabsProvider groups={await hrmViewTabGroups(authz)}>{children}</ViewTabsProvider>
}
