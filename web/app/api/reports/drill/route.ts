import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { parseReportDrillTarget } from '../../../../lib/report-drill'
import { overlayLedgerDrillPeriod } from '../../../../lib/report-drill-period'
import { loadReportDrillData } from '../../../../lib/report-drill-data'
import { reportDrillErrorResponse } from '../../../../lib/report-drill-error'

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
    const scoped = await overlayLedgerDrillPeriod(target, {
      period: url.searchParams.get('period'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    }, gate.user.orgId)
    return NextResponse.json(await loadReportDrillData(scoped, gate, requestedPage))
  } catch (error) {
    return reportDrillErrorResponse(error)
  }
}
