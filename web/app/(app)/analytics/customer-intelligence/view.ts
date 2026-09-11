import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { customerData, customerProfitability } from '../../../../lib/analytics/customer-data'
import type { CustomerView } from './CustomerView'

/**
 * Customer intelligence, split into a loader and a spec.
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

type ViewProps = Parameters<typeof CustomerView>[0]

export interface CustomerIntelligenceData {
  title: string
  backLabel: string
  periodLabel: string
  profitability: ViewProps['profitability']
  projectsEnabled: boolean
  data: ViewProps['data']
}

export async function loadCustomerIntelligence(sp: Record<string, string | undefined>): Promise<CustomerIntelligenceData> {
  const t = await getTranslations('analytics.customer')
  const authz = await requirePermission('reports.read')

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const [data, profitability, projectsEnabled] = await Promise.all([
    customerData({ from: period.from, to: period.to, label: period.label }, authz.user.orgId, authz.allowedSubsidiaryIds),
    customerProfitability({ from: period.from, to: period.to }, authz.user.orgId, authz.allowedSubsidiaryIds),
    isFeatureEnabled(authz.user.orgId, 'projects'),
  ])

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    profitability,
    projectsEnabled,
    data,
  }
}

export function customerIntelligenceSpec(data: CustomerIntelligenceData): PageSpec {
  return page({
    route: '/analytics/customer-intelligence',
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('customer-view', { data: data.data, profitability: data.profitability, projectsEnabled: data.projectsEnabled })],
  })
}
