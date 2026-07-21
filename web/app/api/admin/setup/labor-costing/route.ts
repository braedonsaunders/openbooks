import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import {
  laborClearingReconciliation,
  postPayrollVariance,
  type LaborCostComponent,
} from '@openbooks/engine/src/labor-costing.ts'

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

const COMPONENT_KINDS = new Set(['percent_of_wage', 'per_hour', 'per_day'])

function cleanComponents(input: unknown): LaborCostComponent[] {
  if (!Array.isArray(input)) return []
  const out: LaborCostComponent[] = []
  for (const c of input.slice(0, 20)) {
    if (!c || typeof c !== 'object') continue
    const kind = String((c as Record<string, unknown>).kind)
    const value = Number((c as Record<string, unknown>).value)
    if (!COMPONENT_KINDS.has(kind) || !Number.isFinite(value) || value < 0) continue
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

export async function PUT(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const body = await req.json().catch(() => ({}))

  const s = body.settings ?? {}
  const settings = {
    mode: s.mode === 'post' ? 'post' : 'off',
    hoursPerDay: Number(s.hoursPerDay) > 0 && Number(s.hoursPerDay) <= 24 ? Number(s.hoursPerDay) : 8,
    annualHours: Number(s.annualHours) > 0 && Number(s.annualHours) <= 8784 ? Number(s.annualHours) : 2080,
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
  const userId = gate.user.id
  const body = await req.json().catch(() => ({}))

  if (body.action === 'save-rate') {
    const employeePartyId = body.employeePartyId ?? null
    const tradeId = body.tradeId ?? null
    if (employeePartyId !== null && !isUuid(employeePartyId)) return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
    if (tradeId !== null && !isUuid(tradeId)) return NextResponse.json({ error: 'invalid trade' }, { status: 422 })
    if (employeePartyId && tradeId) return NextResponse.json({ error: 'scope is employee OR trade, not both' }, { status: 422 })
    const rate = Number(body.rate)
    if (!Number.isFinite(rate) || rate < 0) return NextResponse.json({ error: 'invalid rate' }, { status: 422 })
    const basis = body.basis === 'year' ? 'year' : 'hour'
    const annualHours = Number(body.annualHours) > 0 ? Number(body.annualHours) : 2080
    const effectiveFrom = body.effectiveFrom
    if (!DATE_RE.test(effectiveFrom ?? '')) return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) required' }, { status: 422 })

    // Close the previous open row in this scope the day before the new start,
    // then upsert (same scope + same start = correction in place).
    await db.execute(sql`
      update labor_cost_rates set effective_to = (${effectiveFrom}::date - 1), updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId}
         and employee_party_id is not distinct from ${employeePartyId}
         and trade_id is not distinct from ${tradeId}
         and effective_from < ${effectiveFrom}::date
         and (effective_to is null or effective_to >= ${effectiveFrom}::date)`)
    await db.execute(sql`
      insert into labor_cost_rates
        (org_id, employee_party_id, trade_id, rate, basis, annual_hours, effective_from, notes, created_by, updated_by)
      values (${orgId}, ${employeePartyId}, ${tradeId}, ${rate}, ${basis}, ${annualHours}, ${effectiveFrom},
              ${body.notes ? String(body.notes).slice(0, 500) : null}, ${userId}, ${userId})
      on conflict (org_id,
                   coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   effective_from)
      do update set rate = excluded.rate, basis = excluded.basis, annual_hours = excluded.annual_hours,
                    notes = excluded.notes, effective_to = null, is_active = true,
                    updated_at = now(), updated_by = ${userId}`)
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
    await db.execute(sql`delete from labor_cost_rates where org_id = ${orgId} and id = ${body.id}`)
    return NextResponse.json({ ok: true })
  }

  // Payroll true-up: read the clearing wash for a period / post its residue.
  const DATE_OK = (v: unknown) => DATE_RE.test(String(v ?? ''))
  if (body.action === 'reconcile') {
    if (!DATE_OK(body.periodStart) || !DATE_OK(body.periodEnd) || body.periodEnd < body.periodStart) {
      return NextResponse.json({ error: 'periodStart/periodEnd (YYYY-MM-DD) required' }, { status: 422 })
    }
    const rec = await laborClearingReconciliation(orgId, body.periodStart, body.periodEnd)
    if (!rec) return NextResponse.json({ error: 'labor clearing account is not configured' }, { status: 422 })
    return NextResponse.json({ ok: true, ...rec })
  }

  if (body.action === 'post-variance') {
    if (!DATE_OK(body.periodStart) || !DATE_OK(body.periodEnd) || body.periodEnd < body.periodStart) {
      return NextResponse.json({ error: 'periodStart/periodEnd (YYYY-MM-DD) required' }, { status: 422 })
    }
    try {
      const result = await postPayrollVariance({ orgId, actorId: userId, periodStart: body.periodStart, periodEnd: body.periodEnd })
      return NextResponse.json({ ok: true, ...result })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
