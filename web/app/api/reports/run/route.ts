import { notFound } from '@/lib/api/responses';
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { validateOrgReportQuery } from '@/lib/custom-record-report-catalog'
import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { guardReportEntity } from '../../../../lib/report-authz'
import {
  REPORT_PREVIEW_ROWS,
  executeReport,
  loadReportDefinition,
  recordReportRun,
} from '../../../../lib/custom-reports'
const POSTBodySchema1 = z.object({
  query: z.json().optional(), definitionId: z.string().uuid().optional(), preview: z.boolean().optional(),
}).refine((body) => body.query !== undefined || body.definitionId !== undefined, { message: 'query or definitionId is required' });


export const runtime = 'nodejs'

/**
 * Execute a report and return its ReportRunResult.
 *
 * Two shapes:
 *   { query }                 — ad-hoc plan (studio live preview). Clamped to
 *                               REPORT_PREVIEW_ROWS unless `preview:false`, and
 *                               NOT recorded as a run.
 *   { definitionId }          — run a saved definition at its configured row
 *                               limit and record a manual report_runs row (so it has
 *                               a downloadable CSV artifact).
 */
export const POST = defineRoute({
  permission: 'reports.read',
  feature: { none: "The requested report entity is checked for effective feature access before its query runs." },
  body: POSTBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { user } = gate
    const entityGate = (entityKey: unknown): Promise<NextResponse | null> =>
        guardReportEntity(gate, { entity: entityKey })

    const body = (routeBody) as {
        query?: unknown
        definitionId?: string
        preview?: boolean
      }
    if (body.definitionId) {
        const def = await loadReportDefinition(user.orgId, body.definitionId)
        if (!def) return notFound('record')
        // The query runner handles entity-query definitions; standard statement
        // definitions are run/exported through resolveReport, not this endpoint.
        if (def.report_type === 'statement' || !def.query) {
          return NextResponse.json({ error: 'not a query report' }, { status: 422 })
        }
        const denied = await entityGate((def.query as { entity?: string }).entity)
        if (denied) return denied
        const run = await recordReportRun({
          orgId: user.orgId,
          userId: user.id,
          definitionId: def.id,
          query: def.query,
          trigger: 'manual',
        })
        if (run.error) {
          const t = await getTranslations('reports.custom.runner')
          return NextResponse.json({ error: t('runFailedHelp') }, { status: 422 })
        }
        return NextResponse.json({ result: run.result, runId: run.runId })
      }
    let query
    try {
        query = await validateOrgReportQuery(gate, body.query)
      } catch (err) {
        return apiErrorResponse(err, { safeStatus: 422 })
      }
    const deniedAdhoc = await entityGate(query.entity)
    if (deniedAdhoc) return deniedAdhoc
    const maxRows = body.preview === false ? undefined : REPORT_PREVIEW_ROWS
    try {
        const result = await executeReport(user.orgId, query, maxRows)
        return NextResponse.json({ result })
      } catch (err) {
        console.error('[reports/run] ad-hoc report execution failed', err)
        const t = await getTranslations('reports.custom.runner')
        return NextResponse.json(
          { error: t('runFailedHelp') },
          { status: 422 },
        )
      }
  },
});
