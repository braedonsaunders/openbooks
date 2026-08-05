import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
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
  try {
    return NextResponse.json(await loadReportDrillData(target, gate, requestedPage))
  } catch (error) {
    console.error('Report drill failed', error)
    return NextResponse.json({ error: 'report_drill_failed' }, { status: 500 })
  }
}
