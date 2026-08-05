import { redirect } from 'next/navigation'
import { getAuthz } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  await requireFeatureEnabled(authz.user.orgId, 'crm')
  return children
}
