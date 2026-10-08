import 'server-only'
import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { CollectionPeriodError } from '../../../../lib/analytics/receivables-metrics'
import { receivablesIntelligenceData, type ReceivablesIntelligence } from '../../../../lib/analytics/receivables-intelligence-data'

export interface ReceivablesIntelligenceData {
  title: string
  backLabel: string
  periodLabel: string
  data: ReceivablesIntelligence & { canConfigure: boolean }
  canOpenCustomers: boolean
}

export async function loadReceivablesIntelligence(sp: Record<string, string | undefined>): Promise<ReceivablesIntelligenceData> {
  await requirePermission('reports.read')
  const authz = await requirePermission('ar.read')
  const q = parseReportQuery(sp)
  const [t, period, today] = await Promise.all([
    getTranslations('analytics.receivables'),
    resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId }),
    businessToday(authz.user.orgId),
  ])
  const asOf = period.to < today ? period.to : today
  if (period.from > asOf) {
    throw new CollectionPeriodError(t('futurePeriod'))
  }
  const data = await receivablesIntelligenceData(authz.user.orgId, period.from, asOf, authz.allowedSubsidiaryIds, sp)
  return { title: t('title'), backLabel: t('backToHub'), periodLabel: period.label,
    data: { ...data, canConfigure: authz.allowedSubsidiaryIds === null && can(authz, 'admin.setup.manage') },
    canOpenCustomers: can(authz, 'parties.read') }
}

export function receivablesIntelligenceSpec(data: ReceivablesIntelligenceData): PageSpec {
  return page({ route: '/analytics/receivables-intelligence', layout: 'list',
    header: [frame('analytics-header', [widgetBlock('report-period-filter')], {
      title: data.title, periodLabel: data.periodLabel, backLabel: data.backLabel,
    })],
    body: [widgetBlock('receivables-view', { data: data.data, canOpenCustomers: data.canOpenCustomers })],
  })
}
