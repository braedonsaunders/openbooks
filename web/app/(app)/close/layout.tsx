import { redirect } from 'next/navigation'
import { getAuthz } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

/**
 * Feature-gate boundary for the whole /close segment.
 *
 * The registry's contract is that a feature which is off "disappears from nav,
 * its routes 404". Only the index loader gated continuousClose, so
 * /close/posting-periods stayed reachable by direct URL with the switch off —
 * UI-only enforcement. Gating in the layout covers every route in this segment
 * at once, the same arrangement as the continuous-close segment layout.
 */
export default async function CloseLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  await requireFeatureEnabled(authz.user.orgId, 'continuousClose')
  return children
}
