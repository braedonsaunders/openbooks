import { redirect } from 'next/navigation'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'

export default async function TrueCostPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'projects')
  const params = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value)
  redirect(`/reports/true-cost?${query}`)
}
