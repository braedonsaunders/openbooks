import 'server-only'
import { validateCustomQuery } from '@openbooks/reports'
import type { Authz } from './authz'
import {
  applyPeriodOverride,
  executeReport,
  loadReportDefinition,
  REPORT_MAX_ROWS,
  reportPeriodField,
} from './custom-reports'
import { withReportAuthz } from './report-execution-context'
import { assertDriverColumns, extractDriverRows } from './allocations-report-query'
import type { ReportDriverRow, ReportDriverRunner } from '../../engine/src/allocations/drivers.ts'

/**
 * The real ReportDriverRunner for `report_definition` drivers (A8), wired
 * into A2's createDriverResolver({ reportRunner }).
 *
 * The stored plan is forced into a two-column rows listing (dimension id,
 * decimal value) over the as-of period window; the report engine's own
 * permission checks stay authoritative by executing inside
 * withReportAuthz under the triggering actor — a caller without
 * reports.read (or outside the definition's scope) gets the engine's
 * denial, never a guessed vector. Non-empty `params` fail loudly: their
 * shape is unspecified, so ignoring them would silently change the
 * measure. Row-mode only: measures and group-bys are refused rather than
 * reinterpreted.
 */
export function createReportDriverRunner(authz: Authz): ReportDriverRunner {
  return {
    async runReport(input): Promise<ReportDriverRow[]> {
      if (input.actorId !== authz.user.id || input.orgId !== authz.user.orgId) {
        throw new Error('report driver: runner bound to a different actor')
      }
      if (Object.keys(input.params).length > 0) {
        throw new Error('report driver: report params are not supported yet — clear them on the driver')
      }
      const definition = await loadReportDefinition(input.orgId, input.reportDefinitionId)
      const stored = definition?.query
      if (!stored || definition.report_type !== 'query') {
        throw new Error('report driver: definition is not a runnable query report')
      }
      assertDriverColumns(stored.entity, input.dimensionColumn, input.valueColumn)
      const field = reportPeriodField(stored)
      if (!field) throw new Error('report driver: report has no period field')
      const query = validateCustomQuery({
        ...applyPeriodOverride(stored, field, { from: input.from, to: input.to }),
        mode: 'rows',
        columns: [input.dimensionColumn, input.valueColumn],
        breakouts: [],
        measures: [],
        groupBy: null,
      })
      const result = await withReportAuthz(authz, () => executeReport(input.orgId, query, REPORT_MAX_ROWS))
      return extractDriverRows(
        result.groups.flatMap((group) => group.rows),
        0,
        1,
      ).map(([dimension, value]) => ({ dimension, value }))
    },
  }
}
