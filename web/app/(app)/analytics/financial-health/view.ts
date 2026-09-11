import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { RATIO_DEFS } from '../../../../lib/analytics/financial-health'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { healthData } from '../../../../lib/analytics/health-data'
import type { FinancialHealthView } from './FinancialHealthView'

/**
 * Financial health, split into a loader and a spec.
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
 * Loader work copied VERBATIM from page.tsx. `RATIO_DEFS` is a static table of ratio
 * definitions, not a component or a capability, so it travels as plain data
 * through the widget exactly as the page passed it as a prop.
 */

type ViewProps = Parameters<typeof FinancialHealthView>[0]

export interface FinancialHealthData {
  title: string
  backLabel: string
  periodLabel: string
  defs: ViewProps['defs']
  budgetsEnabled: boolean
  data: ViewProps['data']
}

export async function loadFinancialHealth(sp: Record<string, string | undefined>): Promise<FinancialHealthData> {
  const t = await getTranslations('analytics.financialHealth')
  const authz = await requirePermission('reports.read')

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const [data, budgetsEnabled] = await Promise.all([
    healthData({ from: period.from, to: period.to, label: period.label }, authz.user.orgId, authz.allowedSubsidiaryIds),
    isFeatureEnabled(authz.user.orgId, 'budgets'),
  ])

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    defs: RATIO_DEFS,
    budgetsEnabled,
    data,
  }
}

export function financialHealthSpec(data: FinancialHealthData): PageSpec {
  return page({
    route: '/analytics/financial-health',
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('financial-health-view', { data: data.data, defs: data.defs, budgetsEnabled: data.budgetsEnabled })],
  })
}
