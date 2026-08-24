import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getTranslations } from 'next-intl/server'
import { Button, PageHeader } from '@openbooks/ui'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  REPORT_ENTITY_MAP,
  type ReportRunResult,
} from '@openbooks/reports'
import { ListPageLayout } from '../../../../../../components/page-layout'
import { Pagination } from '../../../../../../components/pagination'
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
import { ReportFilterBar, type ExtraPeriodOption } from '../../../ReportFilterBar'
import { ScheduleReportButton } from '../../../ScheduleReportButton'
import { ExportMenu } from '../../../ExportMenu'
import { SaveViewButton } from '../../../SaveViewButton'
import { ReportPaper } from '../../../ReportPaper'
import { ResultView } from '../../ResultView'

export const dynamic = 'force-dynamic'

/**
 * A saved query report IS a regular report: this screen is the exact native
 * report chrome — header back to the hub, filter-bar row with Export, and the
 * paper, already run. Definition management (builder, delivery schedules, run
 * history) lives on its own screens, never here.
 */
export default async function ReportRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const { id } = await params
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

  const sp = await searchParams
  const pagination = entity?.pagination
  const page = pagination
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
  const tk = await getTranslations('reports.custom')
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
          offset: (page - 1) * perPage,
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

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={displayName}
            description={periodLabel}
            back={{ href: '/reports', label: t('hub.title') }}
          />
          <ReportFilterBar
            controls={{ period: Boolean(periodField) }}
            extraPeriods={extraPeriods}
            actions={
              <>
                {canCreate ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/reports/custom/builder/${definition.id}`}>{tc('actions.edit')}</Link>
                  </Button>
                ) : null}
                <ScheduleReportButton
                  definitionId={definition.id}
                  historyHref={`/reports/custom/run/${definition.id}/delivery`}
                />
                <SaveViewButton />
                <ExportMenu baseHref={`/api/reports/definitions/${definition.id}/export${exportQs}`} />
              </>
            }
          />
        </>
      }
    >
      {result ? (
        <ResultView
          company={branding.orgName}
          title={displayName}
          description={periodPhrase ?? displayDescription}
          result={result}
          drillTarget={{ kind: 'custom', source: 'definition', id: definition.id, label: displayName }}
        />
      ) : (
        <ReportPaper company={branding.orgName} title={displayName} periodPhrase={periodPhrase ?? displayDescription ?? undefined}>
          <p className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">{error}</p>
        </ReportPaper>
      )}
      {result?.pageInfo ? (
        <Pagination
          basePath={`/reports/custom/run/${definition.id}`}
          currentParams={sp}
          total={result.pageInfo.totalRows}
          page={page}
          perPage={perPage}
        />
      ) : null}
    </ListPageLayout>
  )
}
