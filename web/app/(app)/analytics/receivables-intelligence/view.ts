import 'server-only'
import { getLocale, getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { receivablesData, type ReceivablesData } from '../../../../lib/analytics/receivables-data'
import { AGING_PERIOD_PRESETS, agingPeriodPreset } from '../../../../lib/aging-periods'

export interface ReceivablesIntelligenceData {
  title: string
  backLabel: string
  periodLabel: string
  data: ReceivablesData
  canOpenCustomers: boolean
}

export async function loadReceivablesIntelligence(sp: Record<string, string | undefined>): Promise<ReceivablesIntelligenceData> {
  await requirePermission('reports.read')
  const authz = await requirePermission('ar.read')
  const q = parseReportQuery({ ...sp, period: agingPeriodPreset(sp.period) })
  const [t, locale, period] = await Promise.all([
    getTranslations('analytics.receivables'), getLocale(),
    resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId }),
  ])
  const data = await receivablesData(authz.user.orgId, period.to, authz.allowedSubsidiaryIds)
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${data.asOf}T00:00:00Z`))
  return { title: t('title'), backLabel: t('backToHub'), periodLabel: t('asOf', { date }), data, canOpenCustomers: can(authz, 'parties.read') }
}

/** Same native composition as Vendor Performance: one header control and
 * one rich dashboard body. Statements remain in the Reports hub. */
export function receivablesIntelligenceSpec(data: ReceivablesIntelligenceData): PageSpec {
  return page({ route: '/analytics/receivables-intelligence', layout: 'list',
    header: [frame('analytics-header', [widgetBlock('report-period-filter', { defaultPeriod: 'today', periodPresets: AGING_PERIOD_PRESETS })], {
      title: data.title, periodLabel: data.periodLabel, backLabel: data.backLabel,
    })],
    body: [widgetBlock('receivables-view', { data: data.data, canOpenCustomers: data.canOpenCustomers })],
  })
}
