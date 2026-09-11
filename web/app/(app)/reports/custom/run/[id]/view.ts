import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getTranslations } from 'next-intl/server'
import {
  filterBar,
  page,
  pageHeader,
  pagination,
  paper,
  ref,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  REPORT_ENTITY_MAP,
  type ReportRunResult,
} from '@openbooks/reports'
import { requirePermission } from '../../../../../../lib/authz'
import { canRunReportEntity } from '../../../../../../lib/report-authz'
import { clamp, isUuid, pickString } from '../../../../../../lib/list-params'
import {
  applyPeriodOverride, executeReport, executeReportPage, loadReportDefinition, reportPeriodField,
} from '../../../../../../lib/custom-reports'
import { statementPageHref } from '../../../../../../lib/report-run'
import { orgBranding } from '../../../../../../lib/report-pdf'
import { parseReportQuery } from '../../../../../../lib/report-filters'
import { resolvePeriod } from '../../../../../../lib/periods'
import type { ExtraPeriodOption } from '../../../ReportFilterBar'
import type { ReportDrillTarget } from '../../../../../../lib/report-drill'

/**
 * A saved query report IS a regular report: this screen is the exact native
 * report chrome — header back to the hub, filter-bar row with Export, and the
 * paper, already run. Definition management (builder, delivery schedules, run
 * history) lives on its own screens, never here.
 *
 * Split into a loader and a spec. Everything below that touches the database,
 * the session, the translations or the URL is loader work copied verbatim from
 * page.tsx — including the permission gates (reports.read, then the
 * entity/Features gate that also guards /api/reports/run), the pagination
 * normalization, the period resolution, the built-in URL-filter application,
 * the payroll pay-period lookup, and the read-only execution. The spec only
 * names blocks and binds already-resolved fields.
 *
 * Three things this page settles:
 *
 * 1. The filter bar's `period` control is data-driven (`Boolean(periodField)`
 *    — a persisted-plan property, not a URL value), and the spec's controls
 *    are static booleans by design. So the spec places TWO filter bars with
 *    complementary loader flags (`hasPeriodField` / `noPeriodField`), the
 *    same treatment the budget page gives its sections control. Both bars
 *    carry the same actions; only the flag differs.
 * 2. The extra period rows — pay periods sitting above the fiscal presets in
 *    their own optgroup — bind through the filter bar's `extraPeriods`,
 *    which the language gained for this page.
 * 3. No `sections.tsx`: the page defines no local components. `ResultView`
 *    (and its `PaperView`/`ReportPaper` interior), `ReportFilterBar`,
 *    `ScheduleReportButton`, `ExportMenu` and `SaveViewButton` are all shared
 *    components, so the widgets reference them directly.
 */

export interface ReportRunData {
  title: string
  description: string | null
  backHref: string
  backLabel: string
  hasPeriodField: boolean
  noPeriodField: boolean
  /** Payroll pay periods offered atop the fiscal presets; undefined otherwise. */
  extraPeriods: ExtraPeriodOption[] | undefined
  canCreate: boolean
  editHref: string
  editLabel: string
  definitionId: string
  historyHref: string
  exportBaseHref: string
  company: string
  periodPhrase: string | null
  periodLabel: string | undefined
  hasResult: boolean
  hasError: boolean
  result: ReportRunResult | null
  drillTarget: ReportDrillTarget | null
  error: string | null
  hasPageInfo: boolean
  pagerBasePath: string
  totalRows: number
  currentPage: number
  perPage: number
}

export async function loadReportRun(
  id: string,
  sp: Record<string, string | undefined>,
): Promise<ReportRunData> {
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  if (!isUuid(id)) notFound()

  const definition = await loadReportDefinition(authz.user.orgId, id)
  if (!definition) notFound()
  // Standard statement definitions are viewed through their rich drill-through
  // pages, not the entity-query runner.
  if (definition.report_type === 'statement') redirect(statementPageHref(definition.statement))
  if (!definition.query) notFound()

  // Sensitive / optional-module entities carry their own permission and
  // Features switch on top of reports.read — same gate as /api/reports/run.
  const entity = REPORT_ENTITY_MAP[(definition.query as { entity?: string }).entity ?? '']
  if (!(await canRunReportEntity(authz, definition.query))) notFound()

  const pagination = entity?.pagination
  const pageNum = pagination
    ? clamp(
        Number(pickString(sp.page) ?? '1'),
        1,
        Math.floor(Number.MAX_SAFE_INTEGER / pagination.maxPageSize),
      )
    : 1
  const perPage = pagination
    ? clamp(
        Number(pickString(sp.perPage) ?? String(pagination.defaultPageSize)),
        1,
        pagination.maxPageSize,
      )
    : 0

  const t = await getTranslations('reports')
  const tc = await getTranslations('common')

  // Built-in definitions localize by slug; custom slugs fall back to stored text.
  const displayName = definition.kind === 'built_in' && t.has(`builtIns.${definition.slug}.name`)
    ? t(`builtIns.${definition.slug}.name`)
    : definition.name
  const displayDescription = definition.kind === 'built_in' && t.has(`builtIns.${definition.slug}.description`)
    ? t(`builtIns.${definition.slug}.description`)
    : definition.description

  // The native period picker governs the report's date field exactly like the
  // statement pages: the URL period (default preset when untouched) replaces
  // the plan's stored window, so the bar always tells the truth.
  // The persisted plan alone decides whether the generic period picker owns a
  // field. URL bindings such as expiresOnOrBefore are independent controls;
  // feeding those back into period detection would replace the user's cutoff
  // with an implicit fiscal window.
  const periodField = reportPeriodField(definition.query)
  let query = definition.query
  let periodPhrase: string | undefined
  let periodLabel: string | undefined
  let queryError: Error | null = null
  try {
    if (definition.kind === 'built_in') {
      const builtIn = BUILT_IN_REPORT_DEFINITION_MAP[definition.slug]
      if (!builtIn) throw new Error(`Unknown built-in report: ${definition.slug}`)
      query = applyBuiltInUrlFilters({ ...builtIn, query }, sp)
    }
    if (periodField) {
      const q = parseReportQuery(sp)
      const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
      query = applyPeriodOverride(query, periodField, { from: period.from, to: period.to })
      periodPhrase = t('pnl.dateRange', { from: period.from, to: period.to })
      periodLabel = period.label
    }
  } catch (err) {
    queryError = err instanceof Error ? err : new Error('Invalid report filters')
  }

  // Payroll reports offer their real pay periods atop the fiscal presets —
  // "one pay period at a time" is THE payroll reporting window.
  let extraPeriods: ExtraPeriodOption[] | undefined
  if (entity?.category === 'payroll') {
    const runs = (await db.execute<{ document_number: string; period_start: string; period_end: string; pay_date: string; schedule: string | null }>(sql`
      select d.document_number, r.period_start, r.period_end, r.pay_date, ps.name as schedule
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join pay_schedules ps on ps.id = r.pay_schedule_id and ps.org_id = r.org_id
       where r.org_id = ${authz.user.orgId}
       order by r.period_end desc
       limit 27
    `))
    // The label names the worked period; the WINDOW is the run's pay date —
    // payroll plans filter on pay_date, which lands after the period ends.
    extraPeriods = runs.rows.map((run) => ({
      id: run.document_number,
      label: `${run.document_number} · ${String(run.period_start).slice(0, 10)} → ${String(run.period_end).slice(0, 10)}${run.schedule ? ` (${run.schedule})` : ''}`,
      from: String(run.pay_date).slice(0, 10),
      to: String(run.pay_date).slice(0, 10),
    }))
  }

  // Exports mirror every effective URL-backed report filter while deliberately
  // omitting viewer pagination. The export route re-applies the same filter
  // bindings to the full result set.
  const exportParams = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    if (!value || key === 'page' || key === 'perPage' || key === 'format') continue
    exportParams.set(key, value)
  }
  const exportQs = exportParams.size ? `?${exportParams}` : ''

  // Native reports land showing data: execute the plan read-only on the
  // server (no report_runs row — scheduled/recorded runs persist their own).
  let result: ReportRunResult | null = null
  let error: string | null = null
  const branding = await orgBranding(authz.user.orgId)
  try {
    if (queryError) throw queryError
    const executed = pagination
      ? await executeReportPage(authz.user.orgId, query, {
          offset: (pageNum - 1) * perPage,
          limit: perPage,
        })
      : await executeReport(authz.user.orgId, query)
    if (pagination && !executed.pageInfo) {
      throw new Error('Paged report result is missing page metadata')
    }
    result = executed
  } catch (err) {
    error = err instanceof Error ? err.message : 'report failed'
  }

  return {
    title: displayName,
    description: displayDescription,
    backHref: '/reports',
    backLabel: t('hub.title'),
    hasPeriodField: Boolean(periodField),
    noPeriodField: !periodField,
    extraPeriods,
    canCreate,
    editHref: `/reports/custom/builder/${definition.id}`,
    editLabel: tc('actions.edit'),
    definitionId: definition.id,
    historyHref: `/reports/custom/run/${definition.id}/delivery`,
    exportBaseHref: `/api/reports/definitions/${definition.id}/export${exportQs}`,
    company: branding.orgName,
    periodPhrase: periodPhrase ?? displayDescription,
    periodLabel,
    hasResult: Boolean(result),
    hasError: !result,
    result,
    drillTarget: result
      ? { kind: 'custom', source: 'definition', id: definition.id, label: displayName }
      : null,
    error,
    hasPageInfo: Boolean(result?.pageInfo),
    pagerBasePath: `/reports/custom/run/${definition.id}`,
    totalRows: result?.pageInfo?.totalRows ?? 0,
    currentPage: pageNum,
    perPage,
  }
}

const f = ref<ReportRunData>()

export function reportRunSpec(data: ReportRunData): PageSpec {
  const edit = widget(
    'link-button',
    { href: data.editHref, label: data.editLabel, variant: 'outline', size: 'sm' },
    f('canCreate'),
  )
  const actions = [
    edit,
    widget('schedule-report', { definitionId: data.definitionId, historyHref: data.historyHref }),
    widget('save-view'),
    widget('export-menu', { baseHref: data.exportBaseHref }),
  ]
  return page({
    route: '/reports/custom/run/[id]',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('periodLabel'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      // The generic period picker owns a date field only when the persisted
      // plan says so — a static-controls language needs both bars, exactly
      // like the budget page's sections pair. `extraPeriods` carries the pay
      // periods that sit above the presets in their own optgroup.
      {
        ...filterBar({ period: true }, { actions, extraPeriods: f('extraPeriods') }),
        when: f('hasPeriodField'),
      },
      {
        ...filterBar({ period: false }, { actions, extraPeriods: f('extraPeriods') }),
        when: f('noPeriodField'),
      },
    ],
    body: [
      // Success: the engine result rendered as the shared sheet of paper.
      // `result-view` is the existing registry widget wrapping ResultView —
      // flat props (company/title/description/result/drillTarget), exactly
      // the shape its entry passes through.
      {
        ...widgetBlock('result-view', {
          company: data.company,
          title: data.title,
          description: data.periodPhrase,
          result: data.result,
          drillTarget: data.drillTarget,
        }),
        when: f('hasResult'),
      },
      // Failure (bad URL filters, engine error): the same paper with the
      // error paragraph this page renders — `py-12 text-center
      // text-sm text-slate-500 dark:text-slate-400`, verbatim.
      {
        ...paper({
          company: f('company'),
          title: f('title'),
          periodPhrase: f('periodPhrase'),
          blocks: [
            textBlock(f('error'), {
              className: 'py-12 text-center text-sm text-slate-500 dark:text-slate-400',
            }),
          ],
        }),
        when: f('hasError'),
      },
      // The native pager sits directly under the paper with no mt-3 wrapper,
      // so the block goes bare.
      {
        ...pagination({
          basePath: f('pagerBasePath'),
          total: f('totalRows'),
          page: f('currentPage'),
          perPage: f('perPage'),
          bare: true,
        }),
        when: f('hasPageInfo'),
      },
    ],
  })
}
