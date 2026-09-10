import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { vendorData } from '../../../../lib/analytics/vendor-data'
import type { VendorView } from './VendorView'

/**
 * Vendor performance, split into a loader and a spec.
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
 * Loader work copied VERBATIM from page.tsx. This page — alone in the family — passes
 * `orgId` to `resolvePeriod`, which lets the org's fiscal calendar name the
 * period. Kept verbatim; a 'consistency' fix here would silently change
 * which dates the dashboard covers.
 */

type ViewProps = Parameters<typeof VendorView>[0]

export interface VendorPerformanceData {
  title: string
  backLabel: string
  periodLabel: string
  data: ViewProps['data']
}

export async function loadVendorPerformance(sp: Record<string, string | undefined>): Promise<VendorPerformanceData> {
  const t = await getTranslations('analytics.vendor')
  const authz = await requirePermission('reports.read')

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId })

  const data = await vendorData({ from: period.from, to: period.to, label: period.label }, authz.user.orgId, authz.allowedSubsidiaryIds)

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    data,
  }
}

export function vendorPerformanceSpec(data: VendorPerformanceData): PageSpec {
  return page({
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('vendor-view', { data: data.data })],
  })
}
