import { redirect } from 'next/navigation'
import { getAuthz } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

/**
 * Feature-gate boundary for the Agent Workbench: same module flag as the
 * continuous-close screen (one module, two doors until the reports tab
 * moves over). Nav hiding alone leaves the page reachable by direct URL.
 */
export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  await requireFeatureEnabled(authz.user.orgId, 'continuousClose')
  return children
}
