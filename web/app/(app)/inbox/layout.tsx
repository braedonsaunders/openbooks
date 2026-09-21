import { redirect } from 'next/navigation'
import { getAuthz } from '../../../lib/authz'

export const dynamic = 'force-dynamic'

/**
 * HR-15: the inbox is core — every leader lands here, so the segment no
 * longer requires the flows feature. Decision legs self-gate in the loader
 * (a caller who cannot approve sees no union rows rather than a 404), and
 * task legs never needed flows at all. Auth still gates the segment: a
 * signed-out visitor goes to login, never to an empty inbox.
 */
export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  return children
}
