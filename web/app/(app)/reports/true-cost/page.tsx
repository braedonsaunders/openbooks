import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader, Button } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { requireProjectsFeature } from '../../../../lib/projects-gate'
import { parseReportQuery } from '../../../../lib/report-filters'
import { resolvePeriod } from '../../../../lib/periods'
import { trueCostExportData } from '../../../../lib/analytics/true-cost-report'
import { orgBranding } from '../../../../lib/report-pdf'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { ReportFilterBar } from '../ReportFilterBar'
import { PaperView } from '../PaperView'
import { ExportMenu } from '../ExportMenu'
import { SaveViewButton } from '../SaveViewButton'
import { ScheduleReportButton } from '../ScheduleReportButton'

export const dynamic = 'force-dynamic'

export default async function TrueCostReport({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await requirePermission('reports.read')
  await requireProjectsFeature(authz.user.orgId)
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId })
  const [data, branding, definitionId, t, tc] = await Promise.all([
    trueCostExportData(authz.user.orgId, period), orgBranding(authz.user.orgId), reportScheduleAnchor('true-cost'),
    getTranslations('reports'), getTranslations('analytics.trueCost'),
  ])
  return <ListPageLayout header={<>
    <PageHeader title={data.title} description={period.label} back={{ href: '/reports', label: t('hub.title') }} />
    <ReportFilterBar controls={{ period: true }} actions={<>
      <Button variant="outline" size="sm" asChild><Link href="/analytics/true-cost/planner">{tc('panels.recoveryPlan')}</Link></Button>
      {definitionId ? <ScheduleReportButton definitionId={definitionId} statementParams={scheduleParamsFrom(sp)} /> : null}
      <SaveViewButton /><ExportMenu kind="true-cost" params={sp} />
    </>} />
  </>}>
    <PaperView company={branding.orgName} currency={branding.baseCurrency} emptyLabel={t('generalLedger.empty')}
      data={{ ...data, periodPhrase: data.dateRangeLabel }} />
  </ListPageLayout>
}
