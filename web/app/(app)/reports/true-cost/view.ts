import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  filterBar,
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireProjectsFeature } from '../../../../lib/projects-gate'
import { parseReportQuery } from '../../../../lib/report-filters'
import { resolvePeriod } from '../../../../lib/periods'
import { trueCostExportData } from '../../../../lib/analytics/true-cost-report'
import { orgBranding } from '../../../../lib/report-pdf'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'

/**
 * The true-cost report, split into a loader and a spec.
 *
 * The body is one `paper-view` placed whole, exactly as the trial balance
 * does for its generic tabular report: PaperView owns the paper chrome, the
 * per-group tables, the summary strip and the money formatting for the
 * unified `{ title, groups }` shape, and re-expressing its five groups as
 * generic `table` blocks would reimplement it, badly. The loader below copies
 * the native page's query, permission and formatting logic verbatim.
 *
 * The filter bar carries one non-standard action: an outline small Button to
 * the recovery-plan planner, placed via the shared `link-button` widget (the
 * same widget the budget page uses for its manage action). `link-button`
 * renders no icon unless `iconKey` names one, so no icon prop is passed.
 */

export interface TrueCostData {
  title: string
  description: string
  backHref: string
  backLabel: string
  plannerHref: string
  plannerLabel: string
  hasScheduleDef: boolean
  scheduleDefId: string
  scheduleParams: Record<string, string>
  exportParams: Record<string, string | undefined>
  company: string
  currency: string
  emptyLabel: string
  paper: unknown
}

export async function loadTrueCost(
  sp: Record<string, string | undefined>,
): Promise<TrueCostData> {
  const authz = await requirePermission('reports.read')
  await requireProjectsFeature(authz.user.orgId)
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId })
  const [data, branding, definitionId, t, tc] = await Promise.all([
    trueCostExportData(authz.user.orgId, period), orgBranding(authz.user.orgId), reportScheduleAnchor('true-cost'),
    getTranslations('reports'), getTranslations('analytics.trueCost'),
  ])
  return {
    title: data.title,
    description: period.label,
    backHref: '/reports',
    backLabel: t('hub.title'),
    plannerHref: '/analytics/true-cost/planner',
    plannerLabel: tc('panels.recoveryPlan'),
    hasScheduleDef: Boolean(definitionId),
    scheduleDefId: definitionId ?? '',
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: sp,
    company: branding.orgName,
    currency: branding.baseCurrency,
    emptyLabel: t('generalLedger.empty'),
    // The native page renames the export title onto `periodPhrase` for the
    // paper header.
    paper: { ...data, periodPhrase: data.dateRangeLabel },
  }
}

const f = ref<TrueCostData>()

export function trueCostSpec(data: TrueCostData): PageSpec {
  const actions = [
    widget('link-button', {
      href: data.plannerHref,
      label: data.plannerLabel,
      variant: 'outline',
      size: 'sm',
    }),
    widget(
      'schedule-report',
      { definitionId: data.scheduleDefId, statementParams: data.scheduleParams },
      f('hasScheduleDef'),
    ),
    widget('save-view'),
    widget('export-menu', { kind: 'true-cost', params: data.exportParams }),
  ]
  return page({
    route: '/reports/true-cost',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      filterBar({ period: true }, { actions }),
    ],
    body: [
      // The true-cost paper stays whole: the summary strip, the five section
      // tables and the money formatting live in the component. The loader
      // hands over the already-assembled export shape.
      widgetBlock('paper-view', {
        company: data.company,
        currency: data.currency,
        emptyLabel: data.emptyLabel,
        data: data.paper,
      }),
    ],
  })
}
