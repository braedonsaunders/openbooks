import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { applyBuiltInUrlFilters, reportMetricQuery, ReportQueryValidationError, type BuiltInReportDefinition, type ReportCustomQuery } from '@openbooks/reports'
import { requirePermission } from '../authz'
import { canRunReportEntity } from '../report-authz'
import { applyPeriodOverride, executeReport, reportPeriodField } from '../custom-reports'
import { parseReportQuery } from '../report-filters'
import { resolvePeriod } from '../periods'

/** Read the stored native plan without reseeding the entire Reports catalog on
 * every live card. A missing seed uses the same native default the detail page
 * materializes; an archived, colliding or inaccessible definition is refused. */
export async function loadAnalyticsReportPreview(source: BuiltInReportDefinition, sp: Record<string, string | undefined>) {
  const authz = await requirePermission('reports.read')
  const stored = await db.execute<{ kind: string; updated_by: string | null; archived_at: unknown; query: ReportCustomQuery | null }>(sql`
    select kind, updated_by, archived_at, query from report_definitions
    where org_id = ${authz.user.orgId} and slug = ${source.slug} limit 1
  `)
  const definition = stored.rows[0]
  if (definition && (definition.kind !== 'built_in' || definition.archived_at || !definition.query)) {
    throw new ReportQueryValidationError('This native analytics report is unavailable. Open Reports to review its definition.')
  }
  let query = definition?.updated_by ? definition.query! : source.query
  if (!(await canRunReportEntity(authz, query))) throw new ReportQueryValidationError('This analytics report is not available with your current features and permissions.')
  const periodField = reportPeriodField(query)
  query = applyBuiltInUrlFilters({ ...source, query }, sp)
  let periodLabel: string | undefined
  if (periodField) {
    const parsed = parseReportQuery(sp)
    const period = await resolvePeriod(parsed.period, { customFrom: parsed.from, customTo: parsed.to })
    query = applyPeriodOverride(query, periodField, { from: period.from, to: period.to })
    periodLabel = period.label
  }
  // Aggregate only the metric band; the native report retains its detailed
  // breakouts. Currency/book census and formula refusal remain engine-owned.
  query = reportMetricQuery(query)
  const result = await executeReport(authz.user.orgId, query)
  if (result.rowCount >= query.limit!) throw new ReportQueryValidationError('This analytics summary has too many currency or accounting-book groups. Open Reports and narrow its filters.')
  return { result, periodLabel, query }
}
