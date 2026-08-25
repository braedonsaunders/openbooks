import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql, type SQL } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
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
 * PUT is a strict financial-policy boundary: every field is validated before
 * any write, and the settings + control accounts + audit row commit in ONE
 * transaction — a rejected save persists nothing, and an accepted save always
 * leaves audit evidence.
 *
 * Wage data is confidential: gated on admin.setup.manage (PMs never see it —
 * projects only ever carry the blended standard cost rate snapshot).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const COMPONENT_KINDS = new Set(['percent_of_wage', 'per_hour', 'per_day', 'worker_comp'])

/** The settings payload carries at most this many burden components. */
const MAX_COMPONENTS = 20

/** Control-account keys this save owns (orgs.settings.controlAccounts paths). */
const CONTROL_ACCOUNT_KEYS = ['laborWip', 'laborClearing', 'payrollVariance'] as const

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Strict financial-policy boundary for burden components. A component that is
 * present but malformed rejects the whole save: the previous parser silently
 * dropped unknown kinds / unparseable or negative values and truncated past
 * 20, so an admin could save believing statutory burden was configured while
 * payroll actually ran without it. Absent optional labels keep their old
 * deterministic defaults; wrong-typed ones are refused.
 */
function parseComponents(input: unknown): Parsed<LaborCostComponent[]> {
  if (input == null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'components must be an array' }
  if (input.length > MAX_COMPONENTS) {
    return { ok: false, error: `at most ${MAX_COMPONENTS} components` }
  }
  const out: LaborCostComponent[] = []
  for (const [i, entry] of input.entries()) {
    const label = `component ${i + 1}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${label}: must be an object` }
    }
    const raw = entry as Record<string, unknown>
    if (typeof raw.kind !== 'string' || !COMPONENT_KINDS.has(raw.kind)) {
      return { ok: false, error: `${label}: unknown kind` }
    }
    const value = canonicalDecimal(raw.value, 4)
    if (value === null) {
      return { ok: false, error: `${label}: value must be a number with at most 4 decimals` }
    }
    if (compareDecimal(value, '0') < 0) {
      return { ok: false, error: `${label}: value cannot be negative` }
    }
    if (raw.scaleWithOvertime !== undefined && typeof raw.scaleWithOvertime !== 'boolean') {
      return { ok: false, error: `${label}: scaleWithOvertime must be a boolean` }
    }
    if (raw.key !== undefined && raw.key !== null && typeof raw.key !== 'string') {
      return { ok: false, error: `${label}: key must be text` }
    }
    if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') {
      return { ok: false, error: `${label}: name must be text` }
    }
    out.push({
      key: (typeof raw.key === 'string' ? raw.key.trim().slice(0, 40) : '') || `c${out.length}`,
      name: (typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '') || 'Component',
      kind: raw.kind as LaborCostComponent['kind'],
      value,
      scaleWithOvertime: raw.scaleWithOvertime === true,
    })
  }
  return { ok: true, value: out }
}

async function configuredCurrencies(orgId: string): Promise<string[]> {
  const result = await db.execute<{ code: string }>(sql`
    select code from (
      select base_currency as code from orgs where id = ${orgId}
      union
      select base_currency as code from subsidiaries where org_id = ${orgId} and is_active
    ) configured order by code`)
  return result.rows.map((row) => row.code)
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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data

  // Validate the ENTIRE payload before any write: a rejected save must leave
  // the stored policy exactly as it was.
  const s = body.settings
  if (s !== undefined && (typeof s !== 'object' || s === null || Array.isArray(s))) {
    return NextResponse.json({ error: 'settings must be an object' }, { status: 422 })
  }
  const cfg = (s ?? {}) as Record<string, unknown>

  const hoursPerDayRaw = cfg.hoursPerDay == null || cfg.hoursPerDay === ''
    ? '8'
    : canonicalDecimal(cfg.hoursPerDay, 4)
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
  const annualHoursRaw = cfg.annualHours == null || cfg.annualHours === ''
    ? '2080'
    : canonicalDecimal(cfg.annualHours, 4)
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
  if (cfg.mode !== undefined && cfg.mode !== 'off' && cfg.mode !== 'post') {
    return NextResponse.json({ error: 'invalid mode' }, { status: 422 })
  }
  const components = parseComponents(cfg.components)
  if (!components.ok) return NextResponse.json({ error: components.error }, { status: 422 })
  const settings = {
    mode: cfg.mode === 'post' ? ('post' as const) : ('off' as const),
    hoursPerDay,
    annualHours,
    components: components.value,
  }

  // Control accounts ride the same save (existing controlAccounts keys).
  const accounts: Record<string, string | null> = {}
  for (const key of CONTROL_ACCOUNT_KEYS) {
    if (!(key in body)) continue
    const v = body[key]
    if (v !== null && !isUuid(v)) return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
    accounts[key] = v
  }
  // A referenced account must be a real posting account in this org.
  const accountIds = [...new Set(Object.values(accounts).filter((v): v is string => v !== null))]
  if (accountIds.length > 0) {
    const found = await db.execute<{ id: string }>(sql`
      select id from accounts
       where org_id = ${orgId} and not is_summary
         and id in (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})`)
    const valid = new Set(found.rows.map((row) => row.id))
    for (const [key, v] of Object.entries(accounts)) {
      if (v !== null && !valid.has(v)) {
        return NextResponse.json(
          { error: `${key}: account not found or is a summary account` },
          { status: 422 },
        )
      }
    }
  }

  // Settings + control accounts + audit evidence commit together or not at
  // all — no partial save can survive a failure past validation.
  await withOrgTransaction(orgId, async () => {
    const current = await db.execute<{ settings: Record<string, unknown> | null }>(sql`
      select settings from orgs where id = ${orgId}`)
    const beforeSettings = (current.rows[0]?.settings ?? {}) as Record<string, unknown>
    const beforeControl = (beforeSettings.controlAccounts ?? {}) as Record<string, unknown>

    // One single-assignment update: every jsonb_set nests around the last.
    let nextSettings: SQL = sql`jsonb_set(coalesce(settings, '{}'::jsonb), '{laborCosting}', ${JSON.stringify(settings)}::jsonb)`
    for (const [key, v] of Object.entries(accounts)) {
      nextSettings = sql`jsonb_set(${nextSettings}, ${`{controlAccounts,${key}}`}::text[], ${JSON.stringify(v)}::jsonb)`
    }
    await db.execute(sql`
      update orgs set settings = ${nextSettings}, updated_at = now(), updated_by = ${gate.user.id}
       where id = ${orgId}`)

    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({
        laborCosting: [beforeSettings.laborCosting ?? null, settings],
        controlAccounts: Object.fromEntries(
          Object.entries(accounts).map(([key, v]) => [key, [beforeControl[key] ?? null, v]]),
        ),
      })}, ${gate.user.id})`)
  })
  return NextResponse.json({ ok: true })
}

export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const userId = gate.user.id
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = parsedBody2.data

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
