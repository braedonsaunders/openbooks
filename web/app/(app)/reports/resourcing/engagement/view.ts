import 'server-only'

import { getTranslations } from 'next-intl/server'
import { ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { orgBranding } from '@/lib/report-pdf'
import { reportRunLabels } from '@/lib/report-labels'
import { dimensionOptions } from '@/lib/reports'
import { statementReportSpec } from '@/lib/reports/statement-report-spec'
import { parseReportQuery } from '@/lib/report-filters'
import { resolvePeriod } from '@/lib/periods'
import { weekStartOf } from '@openbooks/engine/src/resourcing/weeks.ts'
import type { ReportRunResult } from '@openbooks/reports'
import { runResourcingReport, type ResourcingBreakout } from '@/lib/resourcing/report-facts'
import type { ReportDrillTarget } from '@/lib/report-drill'

const REPORT_BREAKOUTS = ["project","customer"] as const

type ReportData = {
  title: string
  description: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  result: ReportRunResult
  drillTarget: ReportDrillTarget
  dimensions: Awaited<ReturnType<typeof dimensionOptions>>
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] }
  searchPlaceholder: string
  exportParams: Record<string, string>
}

function breakoutValue(value: string | undefined): ResourcingBreakout {
  return REPORT_BREAKOUTS.includes(value as never) ? value as ResourcingBreakout : 'project'
}

export async function loadEngagementReport(sp: Record<string, string | undefined>): Promise<ReportData> {
  const authz = await requirePermission('resourcing.read')
  await requireFeatureEnabled(authz.user.orgId, 'resourcing')
  const [t, rt, branding, reportsT] = await Promise.all([
    getTranslations('resourcing.reports.engagement'),
    reportRunLabels(),
    orgBranding(authz.user.orgId),
    getTranslations('reports'),
  ])
  const parsed = parseReportQuery(sp)
  const period = await resolvePeriod(parsed.period, { customFrom: parsed.from, customTo: parsed.to, orgId: authz.user.orgId })
  const firstSunday = weekStartOf(period.from)
  const lastSunday = weekStartOf(period.to)
  const selectedBreakout = breakoutValue(sp.breakout)
  const departmentId = parsed.dims.departmentId
  const jobTitleSearch = sp.q?.trim() || undefined
  const result = await runResourcingReport(
    'engagement',
    authz.user.orgId,
    authz.allowedSubsidiaryIds,
    { firstSunday, lastSunday },
    { departmentId, jobTitleSearch, breakout: selectedBreakout },
    {
      report: rt,
      formulas: {
        utilization: t('measures.utilization'),
        booked: t('measures.booked'),
        gap: t('measures.gap'),
        fill: t('measures.fill'),
        margin: t('measures.margin'),
        marginPercent: t('measures.marginPercent'),
        personCount: t('measures.personCount'),
        unknownCapacity: t('measures.unknownCapacity'),
        unpricedCount: t('measures.unpricedCount'),
        uncostedCount: t('measures.uncostedCount'),
        pricedCount: t('measures.pricedCount'),
        costedCount: t('measures.costedCount'),
        noCapacity: t('guards.noCapacity'),
        noRevenue: t('guards.noRevenue'),
        noCost: t('guards.noCost'),
        undefined: t('guards.undefined'),
      },
    },
  )
  const dims = await dimensionOptions(authz.user.orgId, undefined, authz.allowedSubsidiaryIds)
  return {
    title: t('title'),
    description: t('description'),
    backHref: '/reports',
    backLabel: reportsT('hub.title'),
    company: branding.orgName,
    periodPhrase: t('periodPhrase', { from: firstSunday, to: lastSunday }),
    result,
    drillTarget: { kind: 'time', label: t('title'), from: firstSunday, to: lastSunday },
    dimensions: { ...dims, projects: [], locations: [], classes: [] },
    primaryFilter: {
      paramKey: 'breakout', label: t('breakout'), value: selectedBreakout,
      options: REPORT_BREAKOUTS.map((value) => ({ value, label: t(`breakouts.${value}`) })),
    },
    searchPlaceholder: t('jobTitleSearch'),
    exportParams: Object.fromEntries(Object.entries(sp).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  }
}

const f = ref<ReportData>()

export function engagementReportSpec(data: ReportData): PageSpec {
  const body = widgetBlock('result-view', {
    company: f('company'),
    title: f('title'),
    description: f('periodPhrase'),
    result: f('result'),
    drillTarget: f('drillTarget'),
  })
  return statementReportSpec({
    route: '/reports/resourcing/engagement',
    header: {
      title: f('title'),
      description: f('description'),
      back: { href: f('backHref'), label: f('backLabel') },
    },
    filters: [{
      controls: { period: true, dimensions: true, search: true },
      options: {
        dimensions: f('dimensions'),
        searchPlaceholder: f('searchPlaceholder'),
        primaryFilter: f('primaryFilter'),
      },
    }],
    exportMenu: { kind: 'resourcing-engagement', params: data.exportParams },
    bodyBeforePaper: [body],
    paper: { company: f('company'), title: f('title'), periodPhrase: f('periodPhrase') },
    blocks: [],
    showPaper: false,
  })
}
