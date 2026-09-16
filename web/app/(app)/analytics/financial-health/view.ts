import 'server-only'

import { getLocale, getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { healthData } from '../../../../lib/analytics/health-data'
import { healthStrings, localizedRatioDefs } from '../../../../lib/analytics/health-strings'
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
 * Loader work copied VERBATIM from page.tsx. Ratio definitions travel as plain
 * data through the widget exactly as the page passed them as a prop — resolved
 * from the analytics catalog (`localizedRatioDefs`) in the request locale.
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

  // Finding sentences and ratio definitions resolve through the analytics
  // catalog in the request locale — the same locale the statements use.
  // Direct loader callers keep the English defaults.
  const [tc, locale] = await Promise.all([getTranslations('analytics'), getLocale()])
  const boundT = (key: string, values?: Record<string, string | number>) => tc(key, values)
  const strings = healthStrings(boundT, locale)
  const [data, budgetsEnabled] = await Promise.all([
    healthData({ from: period.from, to: period.to, label: period.label }, authz.user.orgId, authz.allowedSubsidiaryIds, strings),
    isFeatureEnabled(authz.user.orgId, 'budgets'),
  ])

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    defs: localizedRatioDefs(boundT),
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
