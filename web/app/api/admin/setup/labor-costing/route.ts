import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import {
  laborClearingReconciliation,
  postPayrollVariance,
  type LaborCostComponent,
} from '@openbooks/engine/src/labor-costing.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal, compareDecimal } from '../../../../../lib/exact-decimal'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'

export const dynamic = 'force-dynamic'

/**
 * Labor Costing workspace API — one route for the whole surface:
 *
 *  PUT  { settings }            org laborCosting settings (mode, hoursPerDay,
 *                               annualHours, components) + the two control
 *                               accounts (laborWip / laborClearing).
 *  POST { action:'save-rate' }  upsert an effective-dated wage. Starting a new
 *                               rate auto-closes the previous open row in the
 *                               same scope the day before — no overlaps, ever.
 *  POST { action:'end-rate' }   set/clear a row's effective_to.
 *  POST { action:'delete-rate' }
 *
 * Wage data is confidential: gated on admin.setup.manage (PMs never see it —
 * projects only ever carry the blended standard cost rate snapshot).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const COMPONENT_KINDS = new Set(['percent_of_wage', 'per_hour', 'per_day', 'worker_comp'])

async function configuredCurrencies(orgId: string): Promise<string[]> {
  const result = await db.execute<{ code: string }>(sql`
    select code from (
      select base_currency as code from orgs where id = ${orgId}
      union
      select base_currency as code from subsidiaries where org_id = ${orgId} and is_active
    ) configured order by code`)
  return result.rows.map((row) => row.code)
}

function cleanComponents(input: unknown): LaborCostComponent[] {
  if (!Array.isArray(input)) return []
  const out: LaborCostComponent[] = []
  for (const c of input.slice(0, 20)) {
    if (!c || typeof c !== 'object') continue
    const kind = String((c as Record<string, unknown>).kind)
    const value = canonicalDecimal((c as Record<string, unknown>).value, 4)
    if (!COMPONENT_KINDS.has(kind) || value === null || compareDecimal(value, '0') < 0) continue
    out.push({
      key: String((c as Record<string, unknown>).key ?? '').slice(0, 40) || `c${out.length}`,
      name: String((c as Record<string, unknown>).name ?? '').slice(0, 120) || 'Component',
      kind: kind as LaborCostComponent['kind'],
      value,
      scaleWithOvertime: (c as Record<string, unknown>).scaleWithOvertime === true,
    })
  }
  return out
}

/** GET ?employee=<partyId> → that employee's wage-rate history (confidential;
 * the employee record's Wages tab reads this). */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const url = new URL(req.url)
  const employee = url.searchParams.get('employee')
  if (!employee || !isUuid(employee)) return NextResponse.json({ error: 'employee required' }, { status: 422 })
  const today = await businessToday(gate.user.orgId)
  const [rates, org, currencies, employeeContext] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select id, rate, currency, basis, annual_hours, effective_from::text as effective_from,
             effective_to::text as effective_to, notes,
             effective_from <= ${today} and (effective_to is null or effective_to >= ${today}) as is_current
        from labor_cost_rates
       where org_id = ${gate.user.orgId} and employee_party_id = ${employee} and is_active
       order by effective_from desc`),
    db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${gate.user.orgId}`),
    configuredCurrencies(gate.user.orgId),
    db.execute<{ base_currency: string | null }>(sql`
      select s.base_currency
        from parties p
        left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id and s.is_active
       where p.org_id = ${gate.user.orgId} and p.id = ${employee}`),
  ])
  const orgCurrency = org.rows[0]?.base_currency ?? 'CAD'
  return NextResponse.json({
    rates: rates.rows,
    currencies,
    defaultCurrency: employeeContext.rows[0]?.base_currency ?? orgCurrency,
  })
}

export async function PUT(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const body = await req.json().catch(() => ({}))

  const s = body.settings ?? {}
  const hoursPerDayRaw = s.hoursPerDay == null || s.hoursPerDay === ''
    ? '8'
    : canonicalDecimal(s.hoursPerDay, 4)
  if (
    hoursPerDayRaw === null ||
    compareDecimal(hoursPerDayRaw, '0') <= 0 ||
    compareDecimal(hoursPerDayRaw, '24') > 0
  ) {
    return NextResponse.json({ error: 'invalid hoursPerDay' }, { status: 422 })
  }
  let hoursPerDay: string
  try {
    hoursPerDay = normalizeMoney(hoursPerDayRaw)
  } catch {
    return NextResponse.json({ error: 'invalid hoursPerDay' }, { status: 422 })
  }
  const annualHoursRaw = s.annualHours == null || s.annualHours === ''
    ? '2080'
    : canonicalDecimal(s.annualHours, 4)
  if (
    annualHoursRaw === null ||
    compareDecimal(annualHoursRaw, '0') <= 0 ||
    compareDecimal(annualHoursRaw, '8784') > 0
  ) {
    return NextResponse.json({ error: 'invalid annualHours' }, { status: 422 })
  }
  let annualHours: string
  try {
    annualHours = normalizeMoney(annualHoursRaw)
  } catch {
    return NextResponse.json({ error: 'invalid annualHours' }, { status: 422 })
  }
  const settings = {
    mode: s.mode === 'post' ? 'post' : 'off',
    hoursPerDay,
    annualHours,
    components: cleanComponents(s.components),
  }
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{laborCosting}', ${JSON.stringify(settings)}::jsonb)
     where id = ${orgId}`)

  // Control accounts ride the same save (existing controlAccounts keys).
  const accounts: Record<string, string | null> = {}
  for (const key of ['laborWip', 'laborClearing', 'payrollVariance'] as const) {
    if (!(key in body)) continue
    const v = body[key]
    if (v !== null && !isUuid(v)) return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
    accounts[key] = v
  }
  for (const [key, v] of Object.entries(accounts)) {
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{controlAccounts,${key}}`}::text[], ${JSON.stringify(v)}::jsonb)
       where id = ${orgId}`)
  }

  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({ laborCosting: settings, ...accounts })}, ${gate.user.id})`)
  return NextResponse.json({ ok: true })
}

export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const userId = gate.user.id
  const body = await req.json().catch(() => ({}))

  if (body.action === 'save-rate') {
    const employeePartyId = body.employeePartyId ?? null
    const jobTitle = typeof body.jobTitle === 'string' && body.jobTitle.trim() ? body.jobTitle.trim().slice(0, 160) : null
    const tradeId = body.tradeId ?? null
    const departmentId = body.departmentId ?? null
    const subsidiaryId = body.subsidiaryId ?? null
    if (employeePartyId !== null && !isUuid(employeePartyId)) return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
    if (tradeId !== null && !isUuid(tradeId)) return NextResponse.json({ error: 'invalid trade' }, { status: 422 })
    if (departmentId !== null && !isUuid(departmentId)) return NextResponse.json({ error: 'invalid department' }, { status: 422 })
    if (subsidiaryId !== null && !isUuid(subsidiaryId)) return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
    if ([employeePartyId, jobTitle, tradeId, departmentId, subsidiaryId].filter(Boolean).length > 1) {
      return NextResponse.json({ error: 'choose exactly one wage scope' }, { status: 422 })
    }
    const scopeRefs = await Promise.all([
      employeePartyId ? db.execute(sql`select 1 from parties p join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active where p.org_id = ${orgId} and p.id = ${employeePartyId} and p.is_active`) : null,
      tradeId ? db.execute(sql`select 1 from trades where org_id = ${orgId} and id = ${tradeId} and is_active`) : null,
      departmentId ? db.execute(sql`select 1 from departments where org_id = ${orgId} and id = ${departmentId} and is_active`) : null,
      subsidiaryId ? db.execute(sql`select 1 from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId} and is_active and not is_elimination`) : null,
    ])
    if (scopeRefs.some((result) => result && result.rows.length !== 1)) return NextResponse.json({ error: 'wage scope is not available' }, { status: 422 })
    const currencies = await configuredCurrencies(orgId)
    const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : ''
    if (!currencies.includes(currency)) return NextResponse.json({ error: 'currency is not configured for this organization' }, { status: 422 })
    const rateRaw = canonicalDecimal(body.rate, 4)
    if (rateRaw === null || compareDecimal(rateRaw, '0') < 0) return NextResponse.json({ error: 'invalid rate' }, { status: 422 })
    const rate = normalizeMoney(rateRaw)
    const basis = body.basis === 'year' ? 'year' : 'hour'
    const annualHoursRaw = body.annualHours == null || body.annualHours === ''
      ? '2080'
      : canonicalDecimal(body.annualHours, 4)
    if (annualHoursRaw === null || compareDecimal(annualHoursRaw, '0') <= 0) {
      return NextResponse.json({ error: 'invalid annualHours' }, { status: 422 })
    }
    let annualHours: string
    try {
      annualHours = normalizeMoney(annualHoursRaw)
    } catch {
      return NextResponse.json({ error: 'invalid annualHours' }, { status: 422 })
    }
    const effectiveFrom = body.effectiveFrom
    if (!DATE_RE.test(effectiveFrom ?? '')) return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 422 })

    // Close the previous open row in this scope the day before the new start,
    // then upsert (same scope + same start = correction in place).
    await db.execute(sql`
      update labor_cost_rates set effective_to = (${effectiveFrom}::date - 1), updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId}
         and employee_party_id is not distinct from ${employeePartyId}
         and lower(job_title) is not distinct from lower(${jobTitle})
         and trade_id is not distinct from ${tradeId}
         and department_id is not distinct from ${departmentId}
         and subsidiary_id is not distinct from ${subsidiaryId}
         and effective_from < ${effectiveFrom}::date
         and (effective_to is null or effective_to >= ${effectiveFrom}::date)`)
    await db.execute(sql`
      insert into labor_cost_rates
        (org_id, employee_party_id, job_title, trade_id, department_id, subsidiary_id, currency,
         rate, basis, annual_hours, effective_from, notes, created_by, updated_by)
      values (${orgId}, ${employeePartyId}, ${jobTitle}, ${tradeId}, ${departmentId}, ${subsidiaryId}, ${currency},
              ${rate}, ${basis}, ${annualHours}, ${effectiveFrom},
              ${body.notes ? String(body.notes).slice(0, 500) : null}, ${userId}, ${userId})
      on conflict (org_id,
                   coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   coalesce(lower(job_title), ''),
                   coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   effective_from)
      do update set rate = excluded.rate, currency = excluded.currency, basis = excluded.basis, annual_hours = excluded.annual_hours,
                    notes = excluded.notes, effective_to = null, is_active = true,
                    updated_at = now(), updated_by = ${userId}
                where labor_cost_rates.org_id = ${orgId}`)
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'end-rate') {
    if (!isUuid(body.id)) return NextResponse.json({ error: 'invalid id' }, { status: 422 })
    const to = body.effectiveTo
    if (to !== null && !DATE_RE.test(to ?? '')) return NextResponse.json({ error: 'invalid effectiveTo' }, { status: 422 })
    await db.execute(sql`
      update labor_cost_rates set effective_to = ${to}, updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId} and id = ${body.id}`)
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'delete-rate') {
    if (!isUuid(body.id)) return NextResponse.json({ error: 'invalid id' }, { status: 422 })
    // Keep the resolved-rate provenance on approved time entries intact.
    await db.execute(sql`
      update labor_cost_rates
         set is_active = false, updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId} and id = ${body.id}`)
    return NextResponse.json({ ok: true })
  }

  // Payroll true-up: read the clearing wash for a period / post its residue.
  const DATE_OK = (v: unknown) => DATE_RE.test(String(v ?? ''))
  if (body.action === 'reconcile') {
    if (!DATE_OK(body.periodStart) || !DATE_OK(body.periodEnd) || body.periodEnd < body.periodStart) {
      return NextResponse.json({ error: 'periodStart/periodEnd (YYYY-MM-DD) required' }, { status: 422 })
    }
    if (!isUuid(body.subsidiaryId)) return NextResponse.json({ error: 'subsidiary required' }, { status: 422 })
    const subsidiary = await db.execute(sql`select 1 from subsidiaries where org_id = ${orgId} and id = ${body.subsidiaryId} and is_active and not is_elimination`)
    if (subsidiary.rows.length !== 1) return NextResponse.json({ error: 'subsidiary is not available' }, { status: 422 })
    const rec = await laborClearingReconciliation(orgId, body.periodStart, body.periodEnd, body.subsidiaryId)
    if (!rec) return NextResponse.json({ error: 'labor clearing account is not configured' }, { status: 422 })
    return NextResponse.json({ ok: true, ...rec })
  }

  if (body.action === 'post-variance') {
    if (!DATE_OK(body.periodStart) || !DATE_OK(body.periodEnd) || body.periodEnd < body.periodStart) {
      return NextResponse.json({ error: 'periodStart/periodEnd (YYYY-MM-DD) required' }, { status: 422 })
    }
    if (!isUuid(body.subsidiaryId)) return NextResponse.json({ error: 'subsidiary required' }, { status: 422 })
    const subsidiary = await db.execute(sql`select 1 from subsidiaries where org_id = ${orgId} and id = ${body.subsidiaryId} and is_active and not is_elimination`)
    if (subsidiary.rows.length !== 1) return NextResponse.json({ error: 'subsidiary is not available' }, { status: 422 })
    try {
      const result = await postPayrollVariance({ orgId, actorId: userId, periodStart: body.periodStart, periodEnd: body.periodEnd, subsidiaryId: body.subsidiaryId })
      return NextResponse.json({ ok: true, ...result })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
