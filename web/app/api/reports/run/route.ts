import { NextResponse } from 'next/server'
import { validateCustomQuery } from '@openbooks/reports'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { can, guardPermission } from '../../../../lib/authz'
import {
  REPORT_MAX_ROWS,
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
 *   { definitionId }          — run a saved definition, capped at 10k rows and
 *                               recorded as a manual report_runs row (so it has
 *                               a downloadable CSV artifact).
 */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  // Sensitive entities (payroll wages) carry their own permission on top of
  // reports.read — enforced here for both saved definitions and ad-hoc plans.
  const entityGate = (entityKey: unknown): NextResponse | null => {
    const entity = typeof entityKey === 'string' ? REPORT_ENTITY_MAP[entityKey] : undefined
    if (entity?.requiredPermission && !can(gate, entity.requiredPermission)) {
      return NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
    }
    return null
  }

  const body = (await req.json()) as {
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
    const denied = entityGate((def.query as { entity?: string }).entity)
    if (denied) return denied
    const run = await recordReportRun({
      orgId: user.orgId,
      userId: user.id,
      definitionId: def.id,
      query: def.query,
      trigger: 'manual',
      maxRows: REPORT_MAX_ROWS,
    })
    if (run.error) return NextResponse.json({ error: run.error }, { status: 422 })
    return NextResponse.json({ result: run.result, runId: run.runId })
  }

  // Ad-hoc plan → validate + execute, no run record (this is the live preview).
  let query
  try {
    query = validateCustomQuery(body.query)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid report query' },
      { status: 422 },
    )
  }
  const deniedAdhoc = entityGate(query.entity)
  if (deniedAdhoc) return deniedAdhoc
  const maxRows = body.preview === false ? REPORT_MAX_ROWS : REPORT_PREVIEW_ROWS
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
