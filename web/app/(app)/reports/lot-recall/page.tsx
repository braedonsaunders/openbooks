import { notFound, redirect } from 'next/navigation'
import { requirePermission } from '../../../../lib/authz'
import { builtInReportDefinitionId } from '../../../../lib/custom-reports'
import { isFeatureEnabled } from '../../../../lib/features'

export const dynamic = 'force-dynamic'

const FORWARDED_PARAMS = new Set([
  'lotNumber',
  'itemId',
  'expiresOnOrBefore',
  'expiring',
  'page',
  'perPage',
])

/**
 * Compatibility entry point for links and saved views created before lot
 * recall joined the shared report engine. The seeded definition owns the
 * report now; this route only resolves its tenant-local id and carries the
 * recall filters into the native runner.
 */
export default async function LotRecallReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('reports.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'inventory'))) notFound()

  const definitionId = await builtInReportDefinitionId(authz.user.orgId, 'lot-recall')
  if (!definitionId) notFound()

  const source = await searchParams
  const forwarded = new URLSearchParams()
  for (const [key, raw] of Object.entries(source)) {
    if (!FORWARDED_PARAMS.has(key)) continue
    for (const value of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      forwarded.append(key, value)
    }
  }
  const query = forwarded.toString()
  redirect(`/reports/custom/run/${definitionId}${query ? `?${query}` : ''}`)
}
