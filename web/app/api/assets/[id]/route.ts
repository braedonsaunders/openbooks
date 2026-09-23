import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { documentRevisionSql, isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { buildAllSchedulesWithRunner } from '@openbooks/engine/src/assets/depreciation.ts'
import { cmp } from '@openbooks/engine/src/money/money.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { postedAssetBasisEditRefusal, type RequestedAssetBasis } from '../../../../lib/asset-basis-guard'
import { loadAsset, loadAssetWithRunner } from '../_lib'
import {
  FieldRefusal,
  checkCustomReferences,
  checkOpeningBasis,
  checkOpeningMonth,
  checkOpeningPair,
  cleanCustomValues,
  customFieldDefinitions,
  moneyOrNull,
  parseAccountOverride,
  parseAssetConvention,
  parseAssetMethod,
  parseDepreciationMethodId,
  parseLifeMonths,
  parseOpeningAmount,
  parseOpeningAsOf,
  parseRatePercent,
  parseTaxDepreciation,
  parseUnitsTotal,
  strOrNull,
  type AssetConvention,
  type AssetMethod,
} from '../_fields'

export const runtime = 'nodejs'

interface ExistingAsset extends Record<string, unknown> {
  id: string
  status: string
  custom: Record<string, unknown> | null
  acquisition_cost: string
  salvage_value: string
  in_service_on: string | null
  depreciation_method: AssetMethod | null
  depreciation_method_id: string | null
  useful_life_months: number | null
  depreciation_rate_percent: string | null
  depreciation_units_total: string | null
  depreciation_convention: AssetConvention | null
  opening_accumulated_depreciation: string | null
  opening_accumulated_as_of: string | null
}

/** Raised inside the save transaction when a posting won the basis race. */
class PostedBasisEditConflict extends Error {}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

/**
 * Legacy sentence vocabulary for PATCH field refusals. The validation RULES
 * live in ../_fields (shared with POST /api/assets); this maps the stable
 * refusal codes back to the exact sentences PATCH has always returned so
 * existing clients and tests see no change.
 */
function patchFieldBad(error: FieldRefusal) {
  switch (error.code) {
    case 'invalid_method': return bad('Invalid depreciation method')
    case 'invalid_convention': return bad('Invalid depreciation convention')
    case 'invalid_life':
      return bad(typeof error.detail === 'string' && error.detail ? error.detail : 'Invalid useful life')
    case 'invalid_rate': return bad('Rate must be an exact non-negative percent')
    case 'invalid_units': return bad('Expected lifetime units must be an exact positive quantity')
    case 'opening_invalid': return bad('Opening accumulated depreciation must be a number')
    case 'opening_negative': return bad('Opening accumulated depreciation must be a non-negative number')
    case 'opening_as_of_invalid': return bad('Opening as-of date must be a real calendar date (YYYY-MM-DD)')
    case 'opening_pair_required': return bad('Opening accumulated depreciation and its as-of date must be set together')
    case 'opening_exceeds_basis': return bad('Opening accumulated depreciation cannot exceed cost minus salvage')
    case 'opening_before_in_service': return bad('Opening as-of date cannot precede the in-service month')
    case 'invalid_asset_account': return bad('Invalid asset account')
    case 'invalid_accumulated_account': return bad('Invalid accumulated depreciation account')
    case 'invalid_expense_account': return bad('Invalid depreciation expense account')
    case 'invalid_formula': return bad('Invalid depreciation formula')
    case 'unknown_formula': return bad('Depreciation formula not found or inactive')
    case 'tax_elections_invalid': return bad('Invalid tax depreciation elections')
    case 'tax_business_use_invalid': return bad('Business use must be between 0 and 100 percent')
    case 'tax_bonus_invalid': return bad('Bonus depreciation must be between 0 and 100 percent')
    case 'tax_section179_invalid': return bad('Section 179 must be non-negative')
    case 'tax_class_invalid': return bad('Invalid tax depreciation class')
    case 'invalid_custom_fields':
      return NextResponse.json({ error: 'Invalid custom fields', fields: error.detail }, { status: 422 })
    case 'unknown_custom_reference':
      return NextResponse.json({ error: `${String(error.detail)} not found in this organization` }, { status: 422 })
    default: return bad('Invalid asset fields')
  }
}

interface PatchBody {
  expectedUpdatedAt?: string
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
  method?: AssetMethod
  depreciationMethodId?: string | null
  lifeMonths?: number | string | null
  ratePercent?: number | string | null
  unitsTotal?: number | string | null
  convention?: AssetConvention | null
  openingAccumulated?: string | number | null
  openingAsOf?: string | null
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
           depreciation_rate_percent, depreciation_units_total, depreciation_convention,
           opening_accumulated_depreciation, opening_accumulated_as_of
      from fixed_assets where id = ${id} and org_id = ${user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `))
  const existing = existRes.rows[0]
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as PatchBody
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json({ error: 'The asset has changed. Reload it before saving.' }, { status: 409 })
  }

  let subsidiaryId: string | undefined
  if (body.subsidiaryId !== undefined) {
    const value = strOrNull(body.subsidiaryId)?.toLowerCase()
    if (!value || !isUuid(value) || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(value))) return bad('invalid_subsidiary')
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
    categoryId = c.toLowerCase()
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

  // -- dates --------------------------------------------------------------
  // acquired_on/in_service_on write straight to date columns: shape alone
  // admits impossible days ('2026-09-31') that Postgres then refuses with a
  // raw driver failure, so require real calendar dates before any write.
  if (body.acquiredOn !== undefined && body.acquiredOn !== null && !isIsoCalendarDate(body.acquiredOn)) {
    return bad('Acquired date must be a real calendar date (YYYY-MM-DD)')
  }
  if (body.inServiceOn !== undefined && body.inServiceOn !== null && !isIsoCalendarDate(body.inServiceOn)) {
    return bad('In-service date must be a real calendar date (YYYY-MM-DD)')
  }

  // -- native GL account overrides, custom fields, tax elections, ---------
  // -- depreciation parameters, opening carry-in (migration 0156) -----------
  // The validation RULES live in ../_fields (shared with POST /api/assets);
  // refusal codes map back to PATCH's legacy sentences via patchFieldBad.
  const customUpdates: Record<string, unknown> = {}
  let customKeys: string[] = []
  let assetAccountId: string | null | undefined
  let accumulatedAccountId: string | null | undefined
  let expenseAccountId: string | null | undefined
  let method: AssetMethod | null | undefined
  let depreciationMethodId: string | null | undefined
  let lifeMonths: number | null | undefined
  let ratePercent: string | null | undefined
  let unitsTotal: string | null | undefined
  let convention: AssetConvention | null | undefined
  let openingAccumulated: string | null | undefined
  let openingAsOf: string | null | undefined
  try {
    assetAccountId = await parseAccountOverride(db, user.orgId, body.assetAccountId, 'invalid_asset_account')
    accumulatedAccountId = await parseAccountOverride(db, user.orgId, body.accumulatedDepreciationAccountId, 'invalid_accumulated_account')
    expenseAccountId = await parseAccountOverride(db, user.orgId, body.depreciationExpenseAccountId, 'invalid_expense_account')

    if (body.custom !== undefined) {
      const defs = await customFieldDefinitions()
      // PATCH custom values are partial: validate the effective bag so an
      // omitted required field can be satisfied by its stored value. The
      // in-transaction merge below applies the cleaned submitted values onto
      // the locked row, so unknown/system keys survive either way.
      const existingCustom =
        existing.custom && typeof existing.custom === 'object'
          ? (existing.custom as Record<string, unknown>)
          : {}
      const validated = cleanCustomValues(defs, { ...existingCustom, ...body.custom })
      if (!validated.ok) {
        throw new FieldRefusal('invalid_custom_fields', validated.errors)
      }
      // Reference custom values are uuid-SHAPED at this point but nothing
      // proves the referenced row belongs to the caller: refuse foreign or
      // dangling ids instead of persisting a cross-tenant pointer.
      // Supplied values only, so legacy bags cannot lock unrelated edits.
      const suppliedCustom: Record<string, unknown> = {}
      for (const key of Object.keys(body.custom)) {
        if (validated.cleaned[key] !== undefined) suppliedCustom[key] = validated.cleaned[key]
      }
      await checkCustomReferences(user.orgId, defs, suppliedCustom)
      // Replace only tenant-defined keys. Connector provenance and account
      // overrides share this JSON object and must survive an ordinary UI edit.
      customKeys = defs.map(def => def.key)
      Object.assign(customUpdates, validated.cleaned)
    }

    const taxClean = await parseTaxDepreciation(db, user.orgId, body.taxDepreciation)
    if (taxClean !== undefined) customUpdates.taxDepreciation = taxClean

    // Legacy parity: an explicit null method was always refused (the method
    // picker never clears), while absent stays untouched.
    if (body.method === null) throw new FieldRefusal('invalid_method')
    method = parseAssetMethod(body.method)
    depreciationMethodId = await parseDepreciationMethodId(db, user.orgId, body.depreciationMethodId)
    lifeMonths = parseLifeMonths(body.lifeMonths)
    ratePercent = parseRatePercent(body.ratePercent)
    unitsTotal = parseUnitsTotal(body.unitsTotal)
    convention = parseAssetConvention(body.convention)

    // Mid-life onboarding figures: pre-cutover accumulated depreciation plus
    // the as-of date it is measured through. Pair/basis/month rules run on
    // the effective values below; once financial history exists the figures
    // join the posted basis (guarded below) — corrections run through
    // controlled adjustments.
    openingAccumulated = parseOpeningAmount(body.openingAccumulated)
    openingAsOf = parseOpeningAsOf(body.openingAsOf)
  } catch (error) {
    if (error instanceof FieldRefusal) return patchFieldBad(error)
    throw error
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
  const effectiveOpening = openingAccumulated !== undefined ? openingAccumulated : existing.opening_accumulated_depreciation
  const effectiveOpeningAsOf = openingAsOf !== undefined ? openingAsOf : existing.opening_accumulated_as_of
  try {
    checkOpeningPair(effectiveOpening, effectiveOpeningAsOf)
    checkOpeningBasis(effectiveOpening, effectiveCost, effectiveSalvage)
    checkOpeningMonth(effectiveOpening, effectiveOpeningAsOf, effectiveInService)
  } catch (error) {
    if (error instanceof FieldRefusal) return patchFieldBad(error)
    throw error
  }
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
    openingAccumulated,
    openingAsOf,
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
    const payload = await db.transaction(async (tx) => {
      // The reads above are only an early refusal. Lock and reload the
      // authoritative asset inside the save transaction so a depreciation
      // posting that commits while this request is preparing cannot be
      // followed by a stale basis update or stale audit before-image.
      const lockedRes = (await tx.execute<ExistingAsset>(sql`
        select fixed_assets.*, ${documentRevisionSql(sql`updated_at`)} as updated_at,
               ${documentRevisionSql(sql`created_at`)} as created_at from fixed_assets
         where id = ${id} and org_id = ${user.orgId}
           ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
         for update`))
      const lockedExisting = lockedRes.rows[0]
      if (!lockedExisting) throw new Error('asset not found')
      if (lockedExisting.updated_at !== body.expectedUpdatedAt) {
        throw new PostedBasisEditConflict('The asset has changed. Reload it before saving.')
      }

      const lockedPostedRes = (await tx.execute(sql`
        select 1 from depreciation_schedules s
        join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
         where s.asset_id = ${id} and s.org_id = ${user.orgId} and l.posted_amount is not null
         limit 1`))
      const lifecycleHistory = (await tx.execute(sql`
        select 1 from asset_events event
        join journal_entries entry on entry.id = event.journal_entry_id and entry.org_id = event.org_id
        where event.org_id = ${user.orgId} and event.asset_id = ${id}
          and entry.status in ('posted', 'reversed') limit 1
      `))
      const hasHistory = !!lockedPostedRes.rows[0] || !!lifecycleHistory.rows[0]
      const lockedBasisConflict = postedAssetBasisEditRefusal(hasHistory, lockedExisting, requestedBasis)
      if (lockedBasisConflict) throw new PostedBasisEditConflict(lockedBasisConflict)
      if (status !== undefined && status !== lockedExisting.status &&
          (!['draft', 'in_service'].includes(lockedExisting.status) || (hasHistory && status === 'draft'))) {
        throw new PostedBasisEditConflict('Use a controlled lifecycle reversal to restore an asset with financial history.')
      }
      if (hasHistory) {
        const protectedSettings: Record<string, string | null | undefined> = {
          category_id: categoryId,
          subsidiary_id: subsidiaryId,
          acquired_on: body.acquiredOn !== undefined ? strOrNull(body.acquiredOn) : undefined,
        }
        const defaults = (await tx.execute<Record<string, unknown>>(sql`
          select asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id
            from asset_categories where id = ${lockedExisting.category_id} and org_id = ${user.orgId}
            for share
        `)).rows[0]
        const accountChanges: Record<string, string | null | undefined> = {
          asset_account_id: assetAccountId,
          accumulated_depreciation_account_id: accumulatedAccountId,
          depreciation_expense_account_id: expenseAccountId,
        }
        const changedSetting = Object.entries(protectedSettings).some(([column, value]) =>
          value !== undefined && value !== lockedExisting[column])
        // The existing drawer resends resolved accounts. A resave that merely
        // repeats the inherited account must remain valid on a posted asset.
        const changedAccount = Object.entries(accountChanges).some(([column, value]) =>
          value !== undefined && (value ?? defaults?.[column]) !== (lockedExisting[column] ?? defaults?.[column]))
        if (changedSetting || changedAccount) {
          throw new PostedBasisEditConflict('Posting accounts, category and legal entity are fixed once asset financial history exists. Use a controlled adjustment instead.')
        }
      }

      // Merge only submitted custom fields against the locked committed row.
      // An unrelated metadata save must never restore stale connector provenance.
      const custom = { ...(lockedExisting.custom ?? {}) }
      for (const key of customKeys) delete custom[key]
      Object.assign(custom, customUpdates)
      const updated = (await tx.execute<ExistingAsset>(sql`
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
      opening_accumulated_depreciation = ${openingAccumulated !== undefined ? openingAccumulated : sql`opening_accumulated_depreciation`},
      opening_accumulated_as_of = ${openingAsOf !== undefined ? openingAsOf : sql`opening_accumulated_as_of`},
      asset_account_id = ${assetAccountId !== undefined ? assetAccountId : sql`asset_account_id`},
      accumulated_depreciation_account_id = ${accumulatedAccountId !== undefined ? accumulatedAccountId : sql`accumulated_depreciation_account_id`},
      depreciation_expense_account_id = ${expenseAccountId !== undefined ? expenseAccountId : sql`depreciation_expense_account_id`},
      custom = ${body.custom !== undefined || body.taxDepreciation !== undefined ? sql`${JSON.stringify(custom)}::jsonb` : sql`custom`},
      status = ${status !== undefined ? status : sql`status`},
      updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
        returning fixed_assets.*, ${documentRevisionSql(sql`updated_at`)} as updated_at,
                  ${documentRevisionSql(sql`created_at`)} as created_at`)).rows[0]
      if (!updated) throw new Error('asset not found')
      await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${user.orgId}, 'fixed_assets', ${id}, 'update',
                  ${JSON.stringify({
                    before: lockedExisting,
                    after: updated,
                  })}::jsonb, ${user.id})`)
      try {
        // Metadata and unchanged-account saves must retain controlled valuation
        // schedules. Financial-history assets cannot change basis through PATCH.
        // Drafts own no postable schedules at all (only in-service assets do),
        // so a draft save never builds — partial drafts legitimately lack
        // schedule inputs, and that absence is not the save's failure.
        if (!hasHistory && (effectiveStatus === 'in_service' || effectiveStatus === 'fully_depreciated')) {
          await buildAllSchedulesWithRunner(
            tx,
            id,
            user.orgId,
            user.id,
            gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
          )
        }
      } catch (error) {
        if (effectiveStatus === 'in_service') throw error
        // Partial drafts legitimately have no category/date/life yet.
      }
      // Return the saved revision while still holding the parent lock.
      return loadAssetWithRunner(tx, id, user.orgId)
    })
    return NextResponse.json(payload)
  } catch (error) {
    if (error instanceof PostedBasisEditConflict) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    return bad(error instanceof Error ? error.message : 'Could not build depreciation schedule')
  }

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
  const visible = (await db.execute<{ status: string }>(sql`
    select status from fixed_assets where id = ${id} and org_id = ${user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `))
  if (!visible.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Only a draft that was never placed in service may be hard-deleted. Any
  // other status — in service, fully depreciated, disposed, written off —
  // owns financial meaning and leaves only through the lifecycle
  // (dispose/write-off with their journals), never through deletion.
  if (visible.rows[0].status !== 'draft') {
    return NextResponse.json(
      { error: `Only draft assets can be deleted (status: ${visible.rows[0].status}). Dispose of or write off the asset instead.` },
      { status: 409 },
    )
  }

  // Lifecycle events are storage-append-only (asset_event_append_only_guard):
  // an impairment, revaluation, disposal, write-off, or reversal can never be
  // deleted, only reversed. Refuse the delete up front with a domain 409 like
  // the depreciation-evidence guard below instead of attempting the delete
  // and tripping the storage guard as a raw 500. The posted journals stay
  // linked to their event evidence either way.
  const lifecycle = (await db.execute(sql`
    select 1 from asset_events where asset_id = ${id} and org_id = ${user.orgId}
     limit 1`))
  if (lifecycle.rows[0]) {
    return NextResponse.json(
      { error: 'This asset has lifecycle history and cannot be deleted. Reverse the lifecycle event instead.' },
      { status: 409 },
    )
  }

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

  // A delete that matches zero rows is a failure, not success: under RLS an
  // unscoped delete silently matches nothing, so the final delete proves its
  // effect with RETURNING instead of reporting {ok} for a no-op.
  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from depreciation_schedule_lines
       where org_id = ${user.orgId}
         and schedule_id in (select id from depreciation_schedules where asset_id = ${id} and org_id = ${user.orgId})`)
    await tx.execute(sql`delete from depreciation_schedules where asset_id = ${id} and org_id = ${user.orgId}`)
    await tx.execute(sql`delete from asset_events where asset_id = ${id} and org_id = ${user.orgId}`)
    const gone = (await tx.execute<{ id: string }>(sql`
      delete from fixed_assets where id = ${id} and org_id = ${user.orgId} returning id
    `))
    if (gone.rows.length !== 1) throw new Error('asset not found')
    return gone.rows[0]!.id
  }).catch(() => null)
  if (!deleted) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json({ ok: true })
}
