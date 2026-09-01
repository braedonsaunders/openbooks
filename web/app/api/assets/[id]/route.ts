import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { buildAllSchedulesWithRunner } from '@openbooks/engine/src/depreciation.ts'
import { cmp, normalizeMoney, toUnits } from '@openbooks/engine/src/money.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { assetBasisChanges, mergedAssetBasis, postedAssetBasisEditRefusal, type RequestedAssetBasis } from '../../../../lib/asset-basis-guard'
import { loadAsset } from '../_lib'

export const runtime = 'nodejs'

const METHODS = ['straight_line', 'declining_balance', 'double_declining', 'units_of_production', 'manual'] as const
const CONVENTIONS = ['full_month', 'mid_month', 'half_year'] as const
type Method = (typeof METHODS)[number]

interface ExistingAsset extends Record<string, unknown> {
  id: string
  status: string
  custom: Record<string, unknown> | null
  acquisition_cost: string
  salvage_value: string
  in_service_on: string | null
  depreciation_method: Method | null
  depreciation_method_id: string | null
  useful_life_months: number | null
  depreciation_rate_percent: string | null
  depreciation_units_total: string | null
  depreciation_convention: (typeof CONVENTIONS)[number] | null
}

/** Raised inside the save transaction when a posting won the basis race. */
class PostedBasisEditConflict extends Error {}

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
  if (v === null || v === undefined || v === '') return null
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

async function acctExists(id: string, orgId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from accounts where id = ${id} and org_id = ${orgId} and not is_summary`,
  ))
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
  depreciationMethodId?: string | null
  lifeMonths?: number | string | null
  ratePercent?: number | string | null
  unitsTotal?: number | string | null
  convention?: (typeof CONVENTIONS)[number] | null
  assetAccountId?: string | null
  accumulatedDepreciationAccountId?: string | null
  depreciationExpenseAccountId?: string | null
  custom?: Record<string, unknown>
  taxDepreciation?: Record<string, Record<string, unknown>>
  status?: string
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.read', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const search = new URL(req.url).searchParams
  const page = Number.parseInt(search.get('page') ?? '1', 10)
  const payload = await loadAsset(id, gate.user.orgId, {
    bookId: search.get('bookId'),
    query: search.get('q') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    perPage: 25,
  })
  if (!payload || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(payload.asset.subsidiary_id)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json(payload)
}

/**
 * Save the asset flyout — all edits go through one explicit Save. Depreciation
 * parameters live in native fixed_assets columns; tenant-defined fields and
 * the three GL account overrides live in fixed_assets.custom. The depreciation
 * basis is immutable once any depreciation has posted (409); while nothing has
 * posted, basis changes remain free and are written to audit_log. After a
 * successful save the primary-book schedule is rebuilt (unposted lines only)
 * so the detail view + a subsequent run reflect the new plan.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existRes = (await db.execute<ExistingAsset>(sql`
    select id, status, custom, acquisition_cost, salvage_value, in_service_on,
           depreciation_method, depreciation_method_id, useful_life_months,
           depreciation_rate_percent, depreciation_units_total, depreciation_convention
      from fixed_assets where id = ${id} and org_id = ${user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `))
  const existing = existRes.rows[0]
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as PatchBody

  let subsidiaryId: string | undefined
  if (body.subsidiaryId !== undefined) {
    const value = strOrNull(body.subsidiaryId)
    if (!value || !isUuid(value)) return bad('invalid_subsidiary')
    const valid = (await db.execute(sql`
      select 1 from subsidiaries
       where id = ${value} and org_id = ${user.orgId} and is_active and not is_elimination`))
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
    ))
    if (!r.rows[0]) return bad('Category not found')
    categoryId = c
  }

  // -- money --------------------------------------------------------------
  let cost: string | undefined
  if (body.acquisitionCost !== undefined) {
    const v = moneyOrNull(body.acquisitionCost)
    if (v === 'invalid') return bad('Acquisition cost must be a number')
    if (v !== null && cmp(v, '0') < 0) return bad('Acquisition cost must be a non-negative number')
    cost = v ?? '0'
  }
  let salvage: string | undefined
  if (body.salvageValue !== undefined) {
    const v = moneyOrNull(body.salvageValue)
    if (v === 'invalid') return bad('Salvage value must be a number')
    if (v !== null && cmp(v, '0') < 0) return bad('Salvage value must be a non-negative number')
    salvage = v ?? '0'
  }

  // -- native GL account overrides -----------------------------------------
  const custom: Record<string, unknown> = { ...(existing.custom ?? {}) }
  async function accountOverride(v: unknown): Promise<string | null | 'invalid'> {
    const s = strOrNull(v)
    if (s === null) return null
    if (!isUuid(s) || !(await acctExists(s, user.orgId))) return 'invalid'
    return s
  }
  const assetAccountId = body.assetAccountId === undefined ? undefined : await accountOverride(body.assetAccountId)
  const accumulatedAccountId = body.accumulatedDepreciationAccountId === undefined ? undefined : await accountOverride(body.accumulatedDepreciationAccountId)
  const expenseAccountId = body.depreciationExpenseAccountId === undefined ? undefined : await accountOverride(body.depreciationExpenseAccountId)
  if (assetAccountId === 'invalid') return bad('Invalid asset account')
  if (accumulatedAccountId === 'invalid') return bad('Invalid accumulated depreciation account')
  if (expenseAccountId === 'invalid') return bad('Invalid depreciation expense account')

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

  if (body.taxDepreciation !== undefined) {
    if (!body.taxDepreciation || typeof body.taxDepreciation !== 'object' || Array.isArray(body.taxDepreciation)) {
      return bad('Invalid tax depreciation elections')
    }
    const clean: Record<string, Record<string, unknown>> = {}
    for (const [regime, raw] of Object.entries(body.taxDepreciation)) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(regime) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return bad('Invalid tax depreciation elections')
      }
      const businessUsePercent = moneyOrNull(raw.businessUsePercent ?? '100')
      const bonusPercent = moneyOrNull(raw.bonusPercent ?? '0')
      const section179 = moneyOrNull(raw.section179 ?? 0)
      if (businessUsePercent === 'invalid' || businessUsePercent === null || cmp(businessUsePercent, '0') < 0 || cmp(businessUsePercent, '100') > 0) {
        return bad('Business use must be between 0 and 100 percent')
      }
      if (bonusPercent === 'invalid' || bonusPercent === null || cmp(bonusPercent, '0') < 0 || cmp(bonusPercent, '100') > 0) {
        return bad('Bonus depreciation must be between 0 and 100 percent')
      }
      if (section179 === 'invalid' || (section179 && cmp(section179, '0') < 0)) return bad('Section 179 must be non-negative')
      const classCode = strOrNull(raw.classCode)
      if (classCode) {
        const valid = (await db.execute(sql`
          select 1 from tax_pool_classes
           where org_id=${user.orgId} and regime=${regime} and class_code=${classCode} and is_active`))
        if (!valid.rows[0]) return bad('Invalid tax depreciation class')
      }
      clean[regime] = { classCode, businessUsePercent, bonusPercent, section179: section179 ?? '0' }
    }
    custom.taxDepreciation = clean
  }

  let method: Method | null | undefined
  if (body.method !== undefined) {
    if (!METHODS.includes(body.method)) return bad('Invalid depreciation method')
    method = body.method
  }
  let depreciationMethodId: string | null | undefined
  if (body.depreciationMethodId !== undefined) {
    const candidate = strOrNull(body.depreciationMethodId)
    if (candidate !== null) {
      if (!isUuid(candidate)) return bad('Invalid depreciation formula')
      const formula = (await db.execute(sql`
        select 1 from depreciation_methods
         where id = ${candidate} and org_id = ${user.orgId} and is_active`))
      if (!formula.rows[0]) return bad('Depreciation formula not found or inactive')
    }
    depreciationMethodId = candidate
  }
  let lifeMonths: number | null | undefined
  if (body.lifeMonths !== undefined) {
    const n = body.lifeMonths === null || body.lifeMonths === '' ? null : Math.trunc(Number(body.lifeMonths))
    if (n !== null && (Number.isNaN(n) || n <= 0)) return bad('Useful life must be a positive number of months')
    lifeMonths = n
  }
  let ratePercent: string | null | undefined
  if (body.ratePercent !== undefined) {
    const rate = body.ratePercent === null || body.ratePercent === '' ? null : canonicalDecimal(body.ratePercent, 4)
    if (body.ratePercent !== null && body.ratePercent !== '' && rate === null) {
      return bad('Rate must be an exact non-negative percent')
    }
    try {
      if (rate !== null && (toUnits(rate) < 0n || cmp(rate, '10000') > 0)) throw new Error('invalid rate')
    } catch {
      return bad('Rate must be an exact non-negative percent')
    }
    ratePercent = rate === null ? null : normalizeMoney(rate)
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
          : (((await db.execute(sql`select in_service_on from fixed_assets where id = ${id} and org_id = ${user.orgId}`)))).rows[0]
              ?.in_service_on
      const effMethod = method !== undefined ? method : existing.depreciation_method
      const effFormula = depreciationMethodId !== undefined ? depreciationMethodId : existing.depreciation_method_id
      const effLife = lifeMonths !== undefined ? lifeMonths : existing.useful_life_months
      const effUnits = unitsTotal !== undefined ? unitsTotal : existing.depreciation_units_total
      if (!effInService) return bad('Set an in-service date before placing the asset in service')
      if ((effFormula || (effMethod !== 'manual' && effMethod !== 'units_of_production')) && (!effLife || effLife <= 0)) {
        return bad('Set a useful life before placing the asset in service')
      }
      if (!effFormula && effMethod === 'units_of_production' && (!effUnits || cmp(effUnits, '0') <= 0)) {
        return bad('Set expected lifetime units before placing the asset in service')
      }
    }
    status = body.status
  }

  const effectiveStatus = status ?? existing.status
  const effectiveMethod = method !== undefined ? method : existing.depreciation_method
  const effectiveFormula = depreciationMethodId !== undefined ? depreciationMethodId : existing.depreciation_method_id
  const effectiveLife = lifeMonths !== undefined ? lifeMonths : existing.useful_life_months
  const effectiveUnits = unitsTotal !== undefined ? unitsTotal : existing.depreciation_units_total
  const effectiveInService = body.inServiceOn !== undefined ? strOrNull(body.inServiceOn) : existing.in_service_on
  const effectiveCost = cost ?? existing.acquisition_cost
  const effectiveSalvage = salvage ?? existing.salvage_value
  if (cmp(effectiveSalvage, effectiveCost) > 0) return bad('Salvage value cannot exceed acquisition cost')
  if (effectiveStatus === 'in_service') {
    if (!effectiveInService) return bad('Set an in-service date before placing the asset in service')
    if ((effectiveFormula || (effectiveMethod !== 'manual' && effectiveMethod !== 'units_of_production')) && (!effectiveLife || effectiveLife <= 0)) {
      return bad('Set a useful life before placing the asset in service')
    }
    if (!effectiveFormula && effectiveMethod === 'units_of_production' && (!effectiveUnits || cmp(effectiveUnits, '0') <= 0)) {
      return bad('Set expected lifetime units before placing the asset in service')
    }
  }

  // The request fields that participate in computing the schedule, compared
  // against the stored basis — the flyout resends every field on each save, so
  // only an actual value change is a basis change.
  const requestedBasis: RequestedAssetBasis = {
    cost,
    salvage,
    lifeMonths,
    ratePercent,
    unitsTotal,
    convention,
    method,
    depreciationMethodId,
    inServiceOn: body.inServiceOn !== undefined ? strOrNull(body.inServiceOn) : undefined,
  }

  // -- posted-basis immutability --------------------------------------------
  // Once any depreciation has posted, the basis the schedule was computed from
  // (cost, salvage, life, in-service date, convention, method/rate/units) is
  // fixed: editing it would replan unposted history and reinterpret the periods
  // already posted. Corrections run through controlled adjustments instead.
  // Nothing has posted yet → the edit stays free.
  const postedRes = (await db.execute(sql`
    select 1 from depreciation_schedules s
    join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
     where s.asset_id = ${id} and s.org_id = ${user.orgId} and l.posted_amount is not null
     limit 1`))
  const basisConflict = postedAssetBasisEditRefusal(!!postedRes.rows[0], existing, requestedBasis)
  if (basisConflict) return NextResponse.json({ error: basisConflict }, { status: 409 })

  if ((method !== undefined && method !== existing.depreciation_method) || (depreciationMethodId !== undefined && depreciationMethodId !== existing.depreciation_method_id)) {
    const inputEvidence = (await db.execute(sql`
      select 1 from depreciation_schedules s
      join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
      where s.org_id = ${user.orgId} and s.asset_id = ${id} and l.source <> 'formula'
      limit 1`))
    if (inputEvidence.rows[0]) return bad('Depreciation method cannot change after manual or production evidence exists')
  }

  try {
    await db.transaction(async (tx) => {
      // The reads above are only an early refusal. Lock and reload the
      // authoritative asset inside the save transaction so a depreciation
      // posting that commits while this request is preparing cannot be
      // followed by a stale basis update or stale audit before-image.
      const lockedRes = (await tx.execute<ExistingAsset>(sql`
        select id, status, custom, acquisition_cost, salvage_value, in_service_on,
               depreciation_method, depreciation_method_id, useful_life_months,
               depreciation_rate_percent, depreciation_units_total, depreciation_convention
          from fixed_assets
         where id = ${id} and org_id = ${user.orgId}
         for update`))
      const lockedExisting = lockedRes.rows[0]
      if (!lockedExisting) throw new Error('asset not found')

      const lockedPostedRes = (await tx.execute(sql`
        select 1 from depreciation_schedules s
        join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
         where s.asset_id = ${id} and s.org_id = ${user.orgId} and l.posted_amount is not null
         limit 1`))
      const lockedBasisConflict = postedAssetBasisEditRefusal(!!lockedPostedRes.rows[0], lockedExisting, requestedBasis)
      if (lockedBasisConflict) throw new PostedBasisEditConflict(lockedBasisConflict)

      // A basis change that IS allowed (nothing has posted) is still audited.
      const basisChanges = assetBasisChanges(lockedExisting, requestedBasis)
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
      depreciation_method_id = ${depreciationMethodId !== undefined ? depreciationMethodId : sql`depreciation_method_id`},
      useful_life_months = ${lifeMonths !== undefined ? lifeMonths : sql`useful_life_months`},
      depreciation_rate_percent = ${ratePercent !== undefined ? ratePercent : sql`depreciation_rate_percent`},
      depreciation_units_total = ${unitsTotal !== undefined ? unitsTotal : sql`depreciation_units_total`},
      depreciation_convention = ${convention !== undefined ? convention : sql`depreciation_convention`},
      asset_account_id = ${assetAccountId !== undefined ? assetAccountId : sql`asset_account_id`},
      accumulated_depreciation_account_id = ${accumulatedAccountId !== undefined ? accumulatedAccountId : sql`accumulated_depreciation_account_id`},
      depreciation_expense_account_id = ${expenseAccountId !== undefined ? expenseAccountId : sql`depreciation_expense_account_id`},
      custom = ${JSON.stringify(custom)}::jsonb,
      status = ${status !== undefined ? status : sql`status`},
      updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}`)
      if (basisChanges.length > 0) {
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${user.orgId}, 'fixed_assets', ${id}, 'update',
                  ${JSON.stringify({
                    before: mergedAssetBasis(lockedExisting, {}),
                    after: mergedAssetBasis(lockedExisting, requestedBasis),
                    fields: basisChanges,
                  })}::jsonb, ${user.id})`)
      }
      try {
        await buildAllSchedulesWithRunner(tx, id, user.orgId, user.id)
      } catch (error) {
        if (effectiveStatus === 'in_service') throw error
        // Partial drafts legitimately have no category/date/life yet.
      }
    })
  } catch (error) {
    if (error instanceof PostedBasisEditConflict) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
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
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const visible = (await db.execute(sql`
    select 1 from fixed_assets where id = ${id} and org_id = ${user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `))
  if (!visible.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const evidence = (await db.execute(sql`
    select 1
      from depreciation_schedules s
      join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
     where s.asset_id = ${id} and s.org_id = ${user.orgId}
       and (l.posted_amount is not null or l.input_id is not null or l.source = 'imported')
     limit 1`))
  if (evidence.rows[0]) {
    return NextResponse.json(
      { error: 'This asset has depreciation evidence and cannot be deleted.' },
      { status: 409 },
    )
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from depreciation_schedule_lines
       where org_id = ${user.orgId}
         and schedule_id in (select id from depreciation_schedules where asset_id = ${id} and org_id = ${user.orgId})`)
    await tx.execute(sql`delete from depreciation_schedules where asset_id = ${id} and org_id = ${user.orgId}`)
    await tx.execute(sql`delete from asset_events where asset_id = ${id} and org_id = ${user.orgId}`)
    await tx.execute(sql`delete from fixed_assets where id = ${id} and org_id = ${user.orgId}`)
  })

  return NextResponse.json({ ok: true })
}
