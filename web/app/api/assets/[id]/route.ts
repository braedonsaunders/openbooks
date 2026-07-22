import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { buildAllSchedulesWithRunner } from '@openbooks/engine/src/depreciation.ts'
import { cmp, normalizeMoney, toUnits } from '@openbooks/engine/src/money.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { loadAsset } from '../_lib'

export const runtime = 'nodejs'

const METHODS = ['straight_line', 'declining_balance', 'double_declining', 'units_of_production', 'manual'] as const
const CONVENTIONS = ['full_month', 'mid_month', 'half_year'] as const
type Method = (typeof METHODS)[number]

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

/** Exact numeric(19,4) money string or null. */
function moneyOrNull(v: unknown): string | null | 'invalid' {
  const s = strOrNull(typeof v === 'number' ? String(v) : v)
  if (s === null) return null
  try {
    return normalizeMoney(s)
  } catch {
    return 'invalid'
  }
}

async function acctExists(id: string, orgId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from accounts where id = ${id} and org_id = ${orgId} and not is_summary`,
  )) as unknown as { rows: unknown[] }
  return !!r.rows[0]
}

interface PatchBody {
  name?: string
  assetNumber?: string
  description?: string | null
  categoryId?: string | null
  subsidiaryId?: string | null
  acquisitionCost?: string | number | null
  salvageValue?: string | number | null
  acquiredOn?: string | null
  inServiceOn?: string | null
  serialNumber?: string | null
  method?: Method
  lifeMonths?: number | string | null
  ratePercent?: number | string | null
  unitsTotal?: number | string | null
  convention?: (typeof CONVENTIONS)[number] | null
  assetAccountId?: string | null
  accumulatedDepreciationAccountId?: string | null
  depreciationExpenseAccountId?: string | null
  custom?: Record<string, unknown>
  status?: string
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('assets.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const payload = await loadAsset(id, gate.user.orgId)
  if (!payload || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(payload.asset.subsidiary_id)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json(payload)
}

/**
 * Save the asset flyout — all edits go through one explicit Save. Depreciation
 * parameters live in native fixed_assets columns; tenant-defined fields and
 * the three GL account overrides live in fixed_assets.custom. After a successful
 * save the primary-book schedule is rebuilt (unposted lines only) so the detail
 * view + a subsequent run reflect the new plan.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('assets.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existRes = (await db.execute(sql`
    select id, status, custom, acquisition_cost, salvage_value, in_service_on,
           depreciation_method, useful_life_months,
           depreciation_rate_percent, depreciation_units_total, depreciation_convention
      from fixed_assets where id = ${id} and org_id = ${user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `)) as unknown as { rows: {
    id: string
    status: string
    custom: Record<string, any> | null
    acquisition_cost: string
    salvage_value: string
    in_service_on: string | null
    depreciation_method: Method | null
    useful_life_months: number | null
    depreciation_rate_percent: string | null
    depreciation_units_total: string | null
    depreciation_convention: (typeof CONVENTIONS)[number] | null
  }[] }
  const existing = existRes.rows[0]
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as PatchBody

  let subsidiaryId: string | undefined
  if (body.subsidiaryId !== undefined) {
    const value = strOrNull(body.subsidiaryId)
    if (!value || !isUuid(value)) return bad('invalid_subsidiary')
    const valid = (await db.execute(sql`
      select 1 from subsidiaries
       where id = ${value} and org_id = ${user.orgId} and is_active and not is_elimination`)) as unknown as {
      rows: unknown[]
    }
    if (!valid.rows[0]) return bad('invalid_subsidiary')
    subsidiaryId = value
  }

  // -- category -----------------------------------------------------------
  let categoryId: string | undefined
  if (body.categoryId !== undefined) {
    const c = strOrNull(body.categoryId)
    if (!c || !isUuid(c)) return bad('Invalid category')
    const r = (await db.execute(
      sql`select 1 from asset_categories where id = ${c} and org_id = ${user.orgId}`,
    )) as unknown as { rows: unknown[] }
    if (!r.rows[0]) return bad('Category not found')
    categoryId = c
  }

  // -- money --------------------------------------------------------------
  let cost: string | undefined
  if (body.acquisitionCost !== undefined) {
    const v = moneyOrNull(body.acquisitionCost)
    if (v === 'invalid') return bad('Acquisition cost must be a number')
    cost = v ?? '0'
  }
  let salvage: string | undefined
  if (body.salvageValue !== undefined) {
    const v = moneyOrNull(body.salvageValue)
    if (v === 'invalid') return bad('Salvage value must be a number')
    salvage = v ?? '0'
  }

  // -- GL account overrides (legacy custom shape) --------------------------
  const custom: Record<string, any> = { ...(existing.custom ?? {}) }
  const accounts: Record<string, string> = { ...(custom.accounts ?? {}) }

  async function setAcct(key: 'asset' | 'accumulated' | 'expense', v: unknown) {
    const s = strOrNull(v)
    if (s === null) {
      delete accounts[key]
      return true
    }
    if (!isUuid(s) || !(await acctExists(s, user.orgId))) return false
    accounts[key] = s
    return true
  }
  if (body.assetAccountId !== undefined && !(await setAcct('asset', body.assetAccountId)))
    return bad('Invalid asset account')
  if (
    body.accumulatedDepreciationAccountId !== undefined &&
    !(await setAcct('accumulated', body.accumulatedDepreciationAccountId))
  )
    return bad('Invalid accumulated depreciation account')
  if (
    body.depreciationExpenseAccountId !== undefined &&
    !(await setAcct('expense', body.depreciationExpenseAccountId))
  )
    return bad('Invalid depreciation expense account')
  custom.accounts = accounts

  if (body.custom !== undefined) {
    const defs = await loadFieldDefs('fixed_assets')
    const validated = validateCustomValues(defs, body.custom)
    if (!validated.ok) {
      return NextResponse.json({ error: 'Invalid custom fields', fields: validated.errors }, { status: 422 })
    }
    // Replace only tenant-defined keys. Connector provenance and account
    // overrides share this JSON object and must survive an ordinary UI edit.
    for (const def of defs) delete custom[def.key]
    Object.assign(custom, validated.cleaned)
  }

  let method: Method | null | undefined
  if (body.method !== undefined) {
    if (!METHODS.includes(body.method)) return bad('Invalid depreciation method')
    method = body.method
  }
  let lifeMonths: number | null | undefined
  if (body.lifeMonths !== undefined) {
    const n = body.lifeMonths === null || body.lifeMonths === '' ? null : Math.trunc(Number(body.lifeMonths))
    if (n !== null && (Number.isNaN(n) || n <= 0)) return bad('Useful life must be a positive number of months')
    lifeMonths = n
  }
  let ratePercent: string | null | undefined
  if (body.ratePercent !== undefined) {
    const rate = body.ratePercent === null || body.ratePercent === '' ? null : String(body.ratePercent)
    try {
      if (rate !== null && (toUnits(rate) < 0n || cmp(rate, '10000') > 0)) throw new Error('invalid rate')
    } catch {
      return bad('Rate must be an exact non-negative percent')
    }
    ratePercent = rate
  }
  let unitsTotal: string | null | undefined
  if (body.unitsTotal !== undefined) {
    const units = moneyOrNull(body.unitsTotal)
    if (units === 'invalid' || (units !== null && cmp(units, '0') <= 0)) {
      return bad('Expected lifetime units must be an exact positive quantity')
    }
    unitsTotal = units
  }
  let convention: (typeof CONVENTIONS)[number] | null | undefined
  if (body.convention !== undefined) {
    if (body.convention !== null && !CONVENTIONS.includes(body.convention)) return bad('Invalid depreciation convention')
    convention = body.convention
  }

  // -- status transition (draft ↔ in_service) -----------------------------
  // Placing an asset in service requires an in-service date and a useful life
  // so a schedule can be built.
  let status: string | undefined
  if (body.status !== undefined) {
    if (!['draft', 'in_service'].includes(body.status)) return bad('Unsupported status transition')
    if (body.status === 'in_service') {
      const effInService =
        body.inServiceOn !== undefined
          ? strOrNull(body.inServiceOn)
          : ((await db.execute(sql`select in_service_on from fixed_assets where id = ${id} and org_id = ${user.orgId}`)) as any).rows[0]
              ?.in_service_on
      const effMethod = method !== undefined ? method : existing.depreciation_method
      const effLife = lifeMonths !== undefined ? lifeMonths : existing.useful_life_months
      const effUnits = unitsTotal !== undefined ? unitsTotal : existing.depreciation_units_total
      if (!effInService) return bad('Set an in-service date before placing the asset in service')
      if (effMethod !== 'manual' && effMethod !== 'units_of_production' && (!effLife || effLife <= 0)) {
        return bad('Set a useful life before placing the asset in service')
      }
      if (effMethod === 'units_of_production' && (!effUnits || cmp(effUnits, '0') <= 0)) {
        return bad('Set expected lifetime units before placing the asset in service')
      }
    }
    status = body.status
  }

  const effectiveStatus = status ?? existing.status
  const effectiveMethod = method !== undefined ? method : existing.depreciation_method
  const effectiveLife = lifeMonths !== undefined ? lifeMonths : existing.useful_life_months
  const effectiveUnits = unitsTotal !== undefined ? unitsTotal : existing.depreciation_units_total
  const effectiveInService = body.inServiceOn !== undefined ? strOrNull(body.inServiceOn) : existing.in_service_on
  const effectiveCost = cost ?? existing.acquisition_cost
  const effectiveSalvage = salvage ?? existing.salvage_value
  if (cmp(effectiveSalvage, effectiveCost) > 0) return bad('Salvage value cannot exceed acquisition cost')
  if (effectiveStatus === 'in_service') {
    if (!effectiveInService) return bad('Set an in-service date before placing the asset in service')
    if (effectiveMethod !== 'manual' && effectiveMethod !== 'units_of_production' && (!effectiveLife || effectiveLife <= 0)) {
      return bad('Set a useful life before placing the asset in service')
    }
    if (effectiveMethod === 'units_of_production' && (!effectiveUnits || cmp(effectiveUnits, '0') <= 0)) {
      return bad('Set expected lifetime units before placing the asset in service')
    }
  }
  if (method !== undefined && method !== existing.depreciation_method) {
    const inputEvidence = (await db.execute(sql`
      select 1 from depreciation_schedules s
      join depreciation_schedule_lines l on l.schedule_id = s.id
      where s.org_id = ${user.orgId} and s.asset_id = ${id} and l.source <> 'formula'
      limit 1`)) as unknown as { rows: unknown[] }
    if (inputEvidence.rows[0]) return bad('Depreciation method cannot change after manual or production evidence exists')
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update fixed_assets set
      name = ${body.name !== undefined ? body.name.trim() || 'New asset' : sql`name`},
      asset_number = ${body.assetNumber !== undefined ? (strOrNull(body.assetNumber) ?? sql`asset_number`) : sql`asset_number`},
      description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
      category_id = ${categoryId !== undefined ? categoryId : sql`category_id`},
      subsidiary_id = ${subsidiaryId !== undefined ? subsidiaryId : sql`subsidiary_id`},
      acquisition_cost = ${cost !== undefined ? cost : sql`acquisition_cost`},
      salvage_value = ${salvage !== undefined ? salvage : sql`salvage_value`},
      acquired_on = ${body.acquiredOn !== undefined ? strOrNull(body.acquiredOn) : sql`acquired_on`},
      in_service_on = ${body.inServiceOn !== undefined ? strOrNull(body.inServiceOn) : sql`in_service_on`},
      serial_number = ${body.serialNumber !== undefined ? strOrNull(body.serialNumber) : sql`serial_number`},
      depreciation_method = ${method !== undefined ? method : sql`depreciation_method`},
      useful_life_months = ${lifeMonths !== undefined ? lifeMonths : sql`useful_life_months`},
      depreciation_rate_percent = ${ratePercent !== undefined ? ratePercent : sql`depreciation_rate_percent`},
      depreciation_units_total = ${unitsTotal !== undefined ? unitsTotal : sql`depreciation_units_total`},
      depreciation_convention = ${convention !== undefined ? convention : sql`depreciation_convention`},
      custom = ${JSON.stringify(custom)}::jsonb,
      status = ${status !== undefined ? status : sql`status`},
      updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}`)
      try {
        await buildAllSchedulesWithRunner(tx, id, user.orgId, user.id)
      } catch (error) {
        if (effectiveStatus === 'in_service') throw error
        // Partial drafts legitimately have no category/date/life yet.
      }
    })
  } catch (error) {
    return bad(error instanceof Error ? error.message : 'Could not build depreciation schedule')
  }

  const payload = await loadAsset(id, user.orgId)
  return NextResponse.json(payload)
}

/**
 * Delete an asset. Assets are NOT documents — a plain delete is fine, but only
 * for a draft that has never posted any depreciation (guarded).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('assets.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const visible = (await db.execute(sql`
    select 1 from fixed_assets where id = ${id} and org_id = ${user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `)) as unknown as { rows: unknown[] }
  if (!visible.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const evidence = (await db.execute(sql`
    select 1
      from depreciation_schedules s
      join depreciation_schedule_lines l on l.schedule_id = s.id
     where s.asset_id = ${id} and s.org_id = ${user.orgId}
       and (l.posted_amount is not null or l.input_id is not null or l.source = 'imported')
     limit 1`)) as unknown as { rows: unknown[] }
  if (evidence.rows[0]) {
    return NextResponse.json(
      { error: 'This asset has depreciation evidence and cannot be deleted.' },
      { status: 409 },
    )
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from depreciation_schedule_lines
       where schedule_id in (select id from depreciation_schedules where asset_id = ${id} and org_id = ${user.orgId})`)
    await tx.execute(sql`delete from depreciation_schedules where asset_id = ${id} and org_id = ${user.orgId}`)
    await tx.execute(sql`delete from asset_events where asset_id = ${id} and org_id = ${user.orgId}`)
    await tx.execute(sql`delete from fixed_assets where id = ${id} and org_id = ${user.orgId}`)
  })

  return NextResponse.json({ ok: true })
}
