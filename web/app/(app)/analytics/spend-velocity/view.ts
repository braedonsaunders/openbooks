import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { spendVelocityData } from '../../../../lib/analytics/spend-velocity-data'
import type { SpendVelocityView } from './SpendVelocityView'

/**
 * Spend velocity, split into a loader and a spec.
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
 * Loader work copied VERBATIM from page.tsx.
 */

type ViewProps = Parameters<typeof SpendVelocityView>[0]

export interface SpendVelocityData {
  title: string
  backLabel: string
  periodLabel: string
  data: ViewProps['data']
}

export async function loadSpendVelocity(sp: Record<string, string | undefined>): Promise<SpendVelocityData> {
  const t = await getTranslations('analytics.spendVelocity')
  const authz = await requirePermission('reports.read')

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const data = await spendVelocityData(authz.user.orgId, { from: period.from, to: period.to, label: period.label }, authz.allowedSubsidiaryIds)

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    data,
  }
}

export function spendVelocitySpec(data: SpendVelocityData): PageSpec {
  return page({
    route: '/analytics/spend-velocity',
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('spend-velocity-view', { data: data.data })],
  })
}
