import { redirect } from 'next/navigation'
import { getAuthz } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

/**
 * Feature-gate boundary for the Subcontracts module.
 *
 * The registry's contract is that a feature which is off "disappears from nav,
 * its routes 404". Nav hiding alone leaves the page reachable by direct URL and
 * by browser history, which is UI-only enforcement — the thing AGENTS.md
 * forbids. Gating in the layout covers every route in this segment at once.
 */
export default async function SubcontractsLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  await requireFeatureEnabled(authz.user.orgId, 'subcontracts')
  return children
}
