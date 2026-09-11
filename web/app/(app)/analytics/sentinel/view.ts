import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { redirect } from 'next/navigation'
import { can, requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { sentinelData } from '../../../../lib/analytics/sentinel-data'
import type { SentinelView } from './SentinelView'

/**
 * Sentinel forensics, split into a loader and a spec.
 *
 * The dashboard shape is the family shape: the compact `AnalyticsHeader`
 * breadcrumb row wrapping ONE control, and a body that is a single bespoke
 * client view. The header is a FRAME because it wraps a spec-authored child;
 * the control is the shared `report-period-filter` widget (`controls={{ period:
 * true }}`), byte-identical across six of the seven dashboards. The body
 * stays whole: charts, drill tables and client filter state live in the view,
 * and decomposing them into generic blocks would reimplement the component
 * rather than compose it.
 *
 * Loader work copied VERBATIM from page.tsx. The gate here is the strictest in the app —
 * full-ledger forensics demands an unrestricted subsidiary fence AND
 * `admin.audit.read`, and anything less redirects to `/`. It runs in the
 * loader, so the gate runs in the loader.
 *
 * `sentinelData` takes the whole `Authz` because it fences its own SQL. That
 * object never reaches the spec: the loader hands the widget the finished
 * findings, which is the whole point of the loader/spec split.
 */

type ViewProps = Parameters<typeof SentinelView>[0]

export interface SentinelData {
  title: string
  backLabel: string
  periodLabel: string
  data: ViewProps['data']
}

export async function loadSentinel(sp: Record<string, string | undefined>): Promise<SentinelData> {
  const t = await getTranslations('analytics.sentinel')
  const authz = await requirePermission('reports.read')
  if (authz.allowedSubsidiaryIds !== null || !can(authz, 'admin.audit.read')) redirect('/')

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await sentinelData(authz.user.orgId, { from: period.from, to: period.to, label: period.label }, authz)

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    data,
  }
}

export function sentinelSpec(data: SentinelData): PageSpec {
  return page({
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('sentinel-view', { data: data.data })],
  })
}
