import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextRequest, NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { guardPermission } from '../../../../lib/authz'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { addCalendarDays, addCalendarMonthsStart, businessToday, startOfMonth, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { calculateForecast } from '../../../../lib/crm'
import { canonicalDecimal, compareDecimal } from '../../../../lib/exact-decimal'

export const runtime = 'nodejs'

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
  if (!isIsoCalendarDate(periodStart) || !isIsoCalendarDate(periodEnd) || periodEnd < periodStart) return NextResponse.json({ error: 'invalid forecast period' }, { status: 422 })
  if (ownerUserId && !isUuid(ownerUserId)) return NextResponse.json({ error: 'invalid owner' }, { status: 422 })
  if (salesTeamId && !isUuid(salesTeamId)) return NextResponse.json({ error: 'invalid sales team' }, { status: 422 })
  // Quotas carry no subsidiary lineage, so a subsidiary-restricted caller
  // must not receive them at all: a quota for an owner or team whose
  // opportunities sit in another entity would leak across the boundary.
  // Fail closed with an explicit notice instead of an empty-looking list.
  const quotasRestricted = gate.allowedSubsidiaryIds !== null
  const [forecast, quotas, snapshots] = (await Promise.all([
    calculateForecast({ orgId: gate.user.orgId, periodStart, periodEnd, ownerUserId, salesTeamId, allowedSubsidiaryIds: gate.allowedSubsidiaryIds }),
    quotasRestricted
      ? Promise.resolve({ rows: [] })
      : db.execute(sql`
      select q.*, u.name as owner_name, t.name as sales_team_name from crm_sales_quotas q
      left join users u on u.id = q.owner_user_id left join crm_sales_teams t on t.id = q.sales_team_id and t.org_id = q.org_id
      where q.org_id = ${gate.user.orgId} and q.period_start <= ${periodEnd}::date and q.period_end >= ${periodStart}::date
        ${ownerUserId ? sql`and q.owner_user_id = ${ownerUserId}` : sql``}
        ${salesTeamId ? sql`and q.sales_team_id = ${salesTeamId}` : sql``}
      order by q.period_start, coalesce(u.name, t.name)`),
    db.execute(sql`
      select s.*, u.name as owner_name, t.name as sales_team_name from crm_forecast_snapshots s
      left join users u on u.id = s.owner_user_id left join crm_sales_teams t on t.id = s.sales_team_id and t.org_id = s.org_id
      where s.org_id = ${gate.user.orgId} and ${gate.allowedSubsidiaryIds === null} and s.period_start = ${periodStart}::date and s.period_end = ${periodEnd}::date
        ${ownerUserId ? sql`and s.owner_user_id = ${ownerUserId}` : sql``}
        ${salesTeamId ? sql`and s.sales_team_id = ${salesTeamId}` : sql``}
      order by s.as_of desc limit 50`),
  ]))
  const t = await getTranslations('crm')
  return NextResponse.json({ periodStart, periodEnd, forecast, quotas: quotas.rows, snapshots: snapshots.rows,
    quotasNotice: quotasRestricted ? t('forecasts.quotasRestrictedNotice') : null })
}

export async function POST(req: NextRequest) {
  const gate = await guardFeaturePermission('crm.forecasts.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  // Stored forecasts aggregate the whole organization and lack entity lineage.
  if (gate.allowedSubsidiaryIds !== null) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data)
  const periodStart = String(body.periodStart ?? '')
  const periodEnd = String(body.periodEnd ?? '')
  if (!isIsoCalendarDate(periodStart) || !isIsoCalendarDate(periodEnd) || periodEnd < periodStart) return NextResponse.json({ error: 'invalid forecast period' }, { status: 422 })
  // An explicit null means the caller is targeting a team (or, with both
  // null, the whole organization). When the owner key is absent we retain the
  // convenient personal-snapshot default. Each target must be a UUID or an
  // explicit null: falsy non-null values (false, 0, "") used to skip the
  // format check, sail through the forecast as unscoped, then die in
  // Postgres on the uuid columns as a generic 500.
  const t = await getTranslations('crm')
  const rawOwnerUserId = Object.prototype.hasOwnProperty.call(body, 'ownerUserId') ? body.ownerUserId : user.id
  if (rawOwnerUserId !== null && (typeof rawOwnerUserId !== 'string' || !isUuid(rawOwnerUserId))) {
    return NextResponse.json({ error: t('forecasts.invalidOwnerTarget') }, { status: 422 })
  }
  const rawSalesTeamId = Object.prototype.hasOwnProperty.call(body, 'salesTeamId') ? body.salesTeamId : null
  if (rawSalesTeamId !== null && (typeof rawSalesTeamId !== 'string' || !isUuid(rawSalesTeamId))) {
    return NextResponse.json({ error: t('forecasts.invalidTeamTarget') }, { status: 422 })
  }
  const ownerUserId = rawOwnerUserId
  const salesTeamId = rawSalesTeamId
  if ((ownerUserId ? 1 : 0) + (salesTeamId ? 1 : 0) > 1) {
    return NextResponse.json({ error: 'choose at most one owner or team' }, { status: 422 })
  }
  const overrideRaw = body.overrideAmount == null || body.overrideAmount === ''
    ? null
    : canonicalDecimal(body.overrideAmount, 4)
  if (body.overrideAmount != null && body.overrideAmount !== '' && (overrideRaw === null || compareDecimal(overrideRaw, '0') < 0)) {
    return NextResponse.json({ error: 'override must be a non-negative amount' }, { status: 422 })
  }
  // override_amount is numeric(19,4): a wider figure would die in Postgres as
  // a raw storage failure (HTTP 500 — this verb has no catch), so refuse it
  // here with a named 422 and nothing written.
  if (overrideRaw !== null && overrideRaw.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15) {
    return NextResponse.json({ error: 'override is out of range — at most 15 whole digits fit the ledger' }, { status: 422 })
  }
  const overrideAmount = overrideRaw === null ? null : normalizeMoney(overrideRaw)
  const kind = body.snapshotKind ?? (overrideAmount === null ? 'calculated' : 'rep_override')
  if (typeof kind !== 'string' || !['calculated', 'rep_override', 'manager_override'].includes(kind)) return NextResponse.json({ error: 'invalid snapshot kind' }, { status: 422 })
  if ((kind === 'calculated') !== (overrideAmount === null)) {
    return NextResponse.json({ error: 'snapshot kind must match the presence of an override amount' }, { status: 422 })
  }
  const requestedCurrency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : null
  if (body.currency != null && (!requestedCurrency || !/^[A-Z]{3}$/.test(requestedCurrency))) {
    return NextResponse.json({ error: 'invalid forecast currency' }, { status: 422 })
  }
  if (kind === 'manager_override' || (ownerUserId !== user.id && overrideAmount !== null)) {
    const overrideGate = await guardPermission('crm.forecasts.override')
    if (overrideGate instanceof NextResponse) return overrideGate
  }
  // calculateForecast only tests these for truthiness, so collapse the
  // already-validated values to its scope type without touching the raw
  // values stored on the snapshot row below.
  const forecast = await calculateForecast({ orgId: user.orgId, periodStart, periodEnd,
    ownerUserId: typeof ownerUserId === 'string' || ownerUserId == null ? ownerUserId : undefined,
    salesTeamId: typeof salesTeamId === 'string' || salesTeamId == null ? salesTeamId : undefined })
  if (overrideAmount !== null && !requestedCurrency && forecast.length !== 1) {
    return NextResponse.json({ error: 'choose one currency for the override amount' }, { status: 422 })
  }
  const created = await db.transaction(async (tx) => {
    if (requestedCurrency && !(await tx.execute(sql`select code from currencies where code=${requestedCurrency}`)).rows.length) {
      return NextResponse.json({ error: 'invalid forecast currency' }, { status: 422 })
    }
    let rows = requestedCurrency ? forecast.filter(row => row.currency === requestedCurrency) : forecast
    const emptyPipeline = rows.length === 0
    if (emptyPipeline) {
      // Zero activity is still forecast evidence. An explicit currency wins;
      // otherwise use the organization's configured reporting basis and stamp
      // that choice. No nonzero amount is converted or borrowed from a currency.
      const currency = requestedCurrency ?? (await tx.execute<{ base_currency: string }>(sql`
        select base_currency from orgs where id=${user.orgId}`)).rows[0]?.base_currency
      if (!currency) return NextResponse.json({ error: 'organization reporting currency is required' }, { status: 422 })
      rows = [{ currency, pipeline_amount: '0.0000', weighted_amount: '0.0000', worst_case_amount: '0.0000',
        most_likely_amount: '0.0000', upside_amount: '0.0000', closed_amount: '0.0000' }]
    }
    const detail = { calculatedAt: new Date().toISOString(), emptyPipeline,
      currencySource: requestedCurrency ? 'selected' : emptyPipeline ? 'organization_base_currency' : 'forecast' }
    const ids: string[] = []
    for (const row of rows) {
      const result = (await tx.execute<{ id: string }>(sql`
        insert into crm_forecast_snapshots
          (org_id, owner_user_id, sales_team_id, period_start, period_end, snapshot_kind, currency,
           pipeline_amount, weighted_amount, worst_case_amount, most_likely_amount, upside_amount,
           closed_amount, override_amount, note, detail, created_by, updated_by)
        values (${user.orgId}, ${ownerUserId}, ${salesTeamId}, ${periodStart}, ${periodEnd}, ${kind}, ${row.currency},
                ${row.pipeline_amount}, ${row.weighted_amount}, ${row.worst_case_amount}, ${row.most_likely_amount},
                ${row.upside_amount}, ${row.closed_amount}, ${overrideAmount}, ${body.note ?? null},
                ${JSON.stringify(detail)}::jsonb, ${user.id}, ${user.id}) returning id`))
      ids.push(result.rows[0]!.id)
    }
    return ids
  })
  if (created instanceof NextResponse) return created
  return NextResponse.json({ ids: created }, { status: 201 })
}
