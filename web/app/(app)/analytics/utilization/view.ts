import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { utilizationData } from '../../../../lib/analytics/utilization-data'
import type { UtilizationView } from './UtilizationView'

/**
 * Utilization, split into a loader and a spec.
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
 * Loader work copied VERBATIM from page.tsx. The `timeTracking` feature gate runs
 * in the loader wherever it renders, so a spec render redirects exactly as the
 * native one does — a gate that only guarded the native path would be a hole.
 */

type ViewProps = Parameters<typeof UtilizationView>[0]

export interface UtilizationData {
  title: string
  backLabel: string
  periodLabel: string
  data: ViewProps['data']
}

export async function loadUtilization(sp: Record<string, string | undefined>): Promise<UtilizationData> {
  const t = await getTranslations('analytics.utilization')
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'timeTracking')

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await utilizationData(authz.user.orgId, { from: period.from, to: period.to, label: period.label }, authz.allowedSubsidiaryIds)

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    data,
  }
}

export function utilizationSpec(data: UtilizationData): PageSpec {
  return page({
    route: '/analytics/utilization',
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('utilization-view', { data: data.data })],
  })
}
