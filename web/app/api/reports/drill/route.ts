import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { parseReportDrillTarget } from '../../../../lib/report-drill'
import { loadReportDrillData } from '../../../../lib/report-drill-data'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const url = new URL(request.url)
  const target = parseReportDrillTarget(url.searchParams.get('target'))
  const requestedPage = Number(url.searchParams.get('page') ?? 1)
  if (!target || !Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 100_000) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  if (target.kind === 'budget' && !(await isFeatureEnabled(gate.user.orgId, 'budgets'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (target.kind === 'time' && !(await isFeatureEnabled(gate.user.orgId, 'timeTracking'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (target.kind === 'orders' && !(await isFeatureEnabled(gate.user.orgId, 'orders'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  try {
    return NextResponse.json(await loadReportDrillData(target, gate, requestedPage))
  } catch (error) {
    // A refused entity is an authorization outcome, not a server fault: report
    // it as 403 so a payroll drill is denied rather than logged as a crash.
    if (error instanceof Error && error.message === 'report_entity_forbidden') {
      return NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
    }
    console.error('Report drill failed', error)
    return NextResponse.json({ error: 'report_drill_failed' }, { status: 500 })
  }
}
