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

  const rawParams = await searchParams
  const source = new URLSearchParams()
  for (const [key, value] of Object.entries(rawParams)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const entry of value) source.append(key, entry)
    } else {
      source.append(key, value)
    }
  }

  const forwarded = new URLSearchParams()
  for (const [key, raw] of Object.entries(rawParams)) {
    if (!FORWARDED_PARAMS.has(key)) continue
    const values = Array.isArray(raw) ? raw : raw ? [raw] : []
    for (const value of values) {
      forwarded.append(key, value)
    }
  }
  for (const [key, value] of source.entries()) {
    if (!key.startsWith('filter.')) continue
    forwarded.append(key, value)
  }

  const viewFilter = source.get('savedView')
  if (viewFilter) forwarded.set('savedView', viewFilter)

  const query = forwarded.toString()
  redirect(`/reports/custom/run/${definitionId}${query ? `?${query}` : ''}`)
}
