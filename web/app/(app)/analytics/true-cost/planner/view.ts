import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { resolvePeriod } from '../../../../../lib/periods'
import { parseReportQuery } from '../../../../../lib/report-filters'
import { trueCostData } from '../../../../../lib/analytics/true-cost-data'
import type { TrueCostView } from '../TrueCostView'

/**
 * The true-cost planner, split into a loader and a spec.
 *
 * The eighth member of the analytics family and the same shape as the other
 * seven: the compact `AnalyticsHeader` frame wrapping the shared period
 * filter, over one bespoke client view. It reuses `report-period-filter`
 * rather than minting a ninth identical entry.
 *
 * The `projects` feature gate runs in the loader, so a spec render redirects
 * exactly as the native one does. A gate that only guarded the native path
 * would be a hole, not a rendering difference.
 */

type ViewProps = Parameters<typeof TrueCostView>[0]

export interface TrueCostPlannerData {
  title: string
  backLabel: string
  periodLabel: string
  data: ViewProps['data']
}

export async function loadTrueCostPlanner(
  sp: Record<string, string | undefined>,
): Promise<TrueCostPlannerData> {
  const t = await getTranslations('analytics.trueCost')
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'projects')

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await trueCostData(
    authz.user.orgId,
    { from: period.from, to: period.to, label: period.label },
    authz.allowedSubsidiaryIds,
  )

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    data,
  }
}

export function trueCostPlannerSpec(data: TrueCostPlannerData): PageSpec {
  return page({
    route: '/analytics/true-cost/planner',
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('true-cost-view', { data: data.data })],
  })
}
