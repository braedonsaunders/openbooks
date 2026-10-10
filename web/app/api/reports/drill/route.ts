import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { isFeatureEnabled } from '../../../../lib/features'
import { parseReportDrillTarget } from '../../../../lib/report-drill'
import { overlayLedgerDrillPeriod } from '../../../../lib/report-drill-period'
import { loadReportDrillData } from '../../../../lib/report-drill-data'
import { reportDrillErrorResponse } from '../../../../lib/report-drill-error'
import { notFound } from "@/lib/api/responses";
import { can } from '../../../../lib/authz'
import { reportDrillPermission } from '../../../../lib/report-authz'


export const runtime = 'nodejs'

export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: "The requested target checks its budgets, time tracking, or orders feature before loading data." },
  handler: async ({ request: request, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const url = new URL(request.url)
    const target = parseReportDrillTarget(url.searchParams.get('target'))
    const requestedPage = Number(url.searchParams.get('page') ?? 1)
    if (!target || !Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 100_000) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
      }
    // A drill returns the rows behind a report figure, so it owes the same
    // domain grant as the report it came from: ledger lines need the ledger
    // grant, open items their side's grant, orders and time their module's.
    const drillPermission = reportDrillPermission(target)
    if (drillPermission && !can(gate, drillPermission)) {
        return NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
      }
    if (target.kind === 'budget' && !(await isFeatureEnabled(gate.user.orgId, 'budgets'))) {
        return notFound("record")
      }
    if (target.kind === 'time' && !(await isFeatureEnabled(gate.user.orgId, 'timeTracking'))) {
        return notFound("record")
      }
    if (target.kind === 'orders' && !(await isFeatureEnabled(gate.user.orgId, 'orders'))) {
        return notFound("record")
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
  },
});
