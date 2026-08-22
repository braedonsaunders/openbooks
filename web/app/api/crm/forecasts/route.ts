import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { addCalendarDays, addCalendarMonthsStart, businessToday, startOfMonth } from '@openbooks/engine/src/business-date.ts'
import { calculateForecast } from '../../../../lib/crm'

export const runtime = 'nodejs'

const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const gate = await guardFeaturePermission('crm.forecasts.read', 'crm')
  if (gate instanceof NextResponse) return gate
  const params = req.nextUrl.searchParams
  const today = await businessToday(gate.user.orgId)
  const defaultStart = startOfMonth(today)
  const defaultEnd = addCalendarDays(addCalendarMonthsStart(defaultStart, 3), -1)
  const periodStart = params.get('periodStart') ?? defaultStart
  const periodEnd = params.get('periodEnd') ?? defaultEnd
  const ownerUserId = params.get('ownerUserId')
  const salesTeamId = params.get('salesTeamId')
  if (!DATE.test(periodStart) || !DATE.test(periodEnd) || periodEnd < periodStart) return NextResponse.json({ error: 'invalid forecast period' }, { status: 422 })
  if (ownerUserId && !isUuid(ownerUserId)) return NextResponse.json({ error: 'invalid owner' }, { status: 422 })
  if (salesTeamId && !isUuid(salesTeamId)) return NextResponse.json({ error: 'invalid sales team' }, { status: 422 })
  const [forecast, quotas, snapshots] = await Promise.all([
    calculateForecast({ orgId: gate.user.orgId, periodStart, periodEnd, ownerUserId, salesTeamId }),
    db.execute(sql`
      select q.*, u.name as owner_name, t.name as sales_team_name from crm_sales_quotas q
      left join users u on u.id = q.owner_user_id left join crm_sales_teams t on t.id = q.sales_team_id and t.org_id = q.org_id
      where q.org_id = ${gate.user.orgId} and q.period_start <= ${periodEnd}::date and q.period_end >= ${periodStart}::date
        ${ownerUserId ? sql`and q.owner_user_id = ${ownerUserId}` : sql``}
        ${salesTeamId ? sql`and q.sales_team_id = ${salesTeamId}` : sql``}
      order by q.period_start, coalesce(u.name, t.name)`),
    db.execute(sql`
      select s.*, u.name as owner_name, t.name as sales_team_name from crm_forecast_snapshots s
      left join users u on u.id = s.owner_user_id left join crm_sales_teams t on t.id = s.sales_team_id and t.org_id = s.org_id
      where s.org_id = ${gate.user.orgId} and s.period_start = ${periodStart}::date and s.period_end = ${periodEnd}::date
        ${ownerUserId ? sql`and s.owner_user_id = ${ownerUserId}` : sql``}
        ${salesTeamId ? sql`and s.sales_team_id = ${salesTeamId}` : sql``}
      order by s.as_of desc limit 50`),
  ]) as any[]
  return NextResponse.json({ periodStart, periodEnd, forecast, quotas: quotas.rows, snapshots: snapshots.rows })
}

export async function POST(req: NextRequest) {
  const gate = await guardFeaturePermission('crm.forecasts.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = await req.json() as Record<string, any>
  const periodStart = String(body.periodStart ?? '')
  const periodEnd = String(body.periodEnd ?? '')
  if (!DATE.test(periodStart) || !DATE.test(periodEnd) || periodEnd < periodStart) return NextResponse.json({ error: 'invalid forecast period' }, { status: 422 })
  // An explicit null means the caller is targeting a team. When the key is
  // absent we retain the convenient personal-snapshot default.
  const ownerUserId = Object.prototype.hasOwnProperty.call(body, 'ownerUserId') ? body.ownerUserId : user.id
  const salesTeamId = body.salesTeamId ?? null
  if ((ownerUserId ? 1 : 0) + (salesTeamId ? 1 : 0) !== 1 || (ownerUserId && !isUuid(ownerUserId)) || (salesTeamId && !isUuid(salesTeamId))) return NextResponse.json({ error: 'choose exactly one owner or team' }, { status: 422 })
  const overrideAmount = body.overrideAmount == null || body.overrideAmount === '' ? null : String(body.overrideAmount)
  const kind = body.snapshotKind ?? (overrideAmount === null ? 'calculated' : 'rep_override')
  if (!['calculated', 'rep_override', 'manager_override'].includes(kind)) return NextResponse.json({ error: 'invalid snapshot kind' }, { status: 422 })
  if (kind === 'manager_override' || (ownerUserId !== user.id && overrideAmount !== null)) {
    const overrideGate = await guardPermission('crm.forecasts.override')
    if (overrideGate instanceof NextResponse) return overrideGate
  }
  if (overrideAmount !== null && !/^\d+(\.\d{0,4})?$/.test(overrideAmount)) return NextResponse.json({ error: 'override must be a non-negative amount' }, { status: 422 })
  const forecast = await calculateForecast({ orgId: user.orgId, periodStart, periodEnd, ownerUserId, salesTeamId })
  const created = await db.transaction(async (tx) => {
    const ids: string[] = []
    for (const row of forecast) {
      const result = (await tx.execute<{ id: string }>(sql`
        insert into crm_forecast_snapshots
          (org_id, owner_user_id, sales_team_id, period_start, period_end, snapshot_kind, currency,
           pipeline_amount, weighted_amount, worst_case_amount, most_likely_amount, upside_amount,
           closed_amount, override_amount, note, detail, created_by, updated_by)
        values (${user.orgId}, ${ownerUserId}, ${salesTeamId}, ${periodStart}, ${periodEnd}, ${kind}, ${row.currency},
                ${row.pipeline_amount}, ${row.weighted_amount}, ${row.worst_case_amount}, ${row.most_likely_amount},
                ${row.upside_amount}, ${row.closed_amount}, ${overrideAmount}, ${body.note ?? null},
                ${JSON.stringify({ calculatedAt: new Date().toISOString() })}::jsonb, ${user.id}, ${user.id}) returning id`))
      ids.push(result.rows[0]!.id)
    }
    return ids
  })
  return NextResponse.json({ ids: created }, { status: 201 })
}
