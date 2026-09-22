import { validateOrgReportQuery } from '@/lib/custom-record-report-catalog'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { guardReportEntity } from '../../../../lib/report-authz'
import {
  REPORT_PREVIEW_ROWS,
  executeReport,
  loadReportDefinition,
  recordReportRun,
} from '../../../../lib/custom-reports'

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
export async function POST(req: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  // Sensitive entities (payroll wages) carry their own permission on top of
  // reports.read. The gate itself lives in lib/report-authz so the runner, the
  // export, the drill and the definition list cannot drift apart.
  const entityGate = (entityKey: unknown): Promise<NextResponse | null> =>
    guardReportEntity(gate, { entity: entityKey })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    query?: unknown
    definitionId?: string
    preview?: boolean
  }

  // Saved definition → execute + record a run with its CSV artifact.
  if (body.definitionId) {
    const def = await loadReportDefinition(user.orgId, body.definitionId)
    if (!def) return NextResponse.json({ error: 'report not found' }, { status: 404 })
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
    if (run.error) return NextResponse.json({ error: run.error }, { status: 422 })
    return NextResponse.json({ result: run.result, runId: run.runId })
  }

  // Ad-hoc plan → validate + execute, no run record (this is the live preview).
  let query
  try {
    query = await validateOrgReportQuery(gate, body.query)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid report query' },
      { status: 422 },
    )
  }
  const deniedAdhoc = await entityGate(query.entity)
  if (deniedAdhoc) return deniedAdhoc
  const maxRows = body.preview === false ? undefined : REPORT_PREVIEW_ROWS
  try {
    const result = await executeReport(user.orgId, query, maxRows)
    return NextResponse.json({ result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Report run failed' },
      { status: 422 },
    )
  }
}
