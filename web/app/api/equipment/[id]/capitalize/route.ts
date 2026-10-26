import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { cmp, normalizeMoney } from '@openbooks/engine/money/money'
import { createDraftAsset, placeDraftInService } from '@openbooks/engine/assets/asset-drafts'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { isFeatureEnabled } from '../../../../../lib/features'
import { isUuid } from '../../../../../lib/list-params'
import { ensureDefaultCategory } from '../../../assets/categories/_ensure'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

type CapitalizationResult =
  | { kind: 'created'; assetId: string; assetNumber: string }
  | { kind: 'already_capitalized' }
  | { kind: 'not_found' }
  | { kind: 'invalid_subsidiary' }
  | { kind: 'acquisition_cost_invalid' }

/**
 * A compare-and-set link that unexpectedly updates no row must abort the
 * transaction. Returning a result would commit the asset insert and strand an
 * unlinked fixed asset, even though the source row is the idempotency gate.
 */
class CapitalizationLinkConflict extends Error {
  constructor() {
    super('equipment unit capitalization compare-and-set conflict')
    this.name = 'CapitalizationLinkConflict'
  }
}

/** Drizzle wraps PostgreSQL errors, so inspect the full cause chain. */
function isCapitalizationRace(error: unknown): boolean {
  let current: unknown = error
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code : null
    const constraint = typeof candidate.constraint === 'string' ? candidate.constraint : null
    const message = typeof candidate.message === 'string' ? candidate.message : String(current)
    if (
      (code === '23505' && constraint === 'fixed_assets_org_asset_number_unique')
      || message.includes('fixed_assets_org_asset_number_unique')
      || message.includes('equipment unit fixed-asset link is immutable after capitalization')
      || message.includes('equipment unit capitalization compare-and-set conflict')
    ) return true
    current = candidate.cause
  }
  return false
}

/**
 * Capitalize an equipment unit as a fixed asset: create the asset prefilled from
 * the unit (cost, dates, serial, subsidiary), link it back onto the unit, and it
 * begins depreciating on the Fixed Assets register. The user refines the asset's
 * category (which drives the depreciation method and tax class) on the asset.
 * In-service dates activate depreciation only when the category supplies a
 * usable schedule configuration; otherwise the asset remains a draft.
 */
export const POST = defineRoute({
  permission: 'assets.manage',
  feature: 'equipment',
  params: z.object({ "id": z.string() }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    // Capitalize writes a fixed_assets row. Equipment being on is not enough —
    // turning Fixed Assets off must stop new register rows without touching
    // units that already exist.
    if (!(await isFeatureEnabled(gate.user.orgId, 'fixedAssets'))) {
      return notFound("record")
    }
    const { id } = await params
    // A malformed id names no unit: same answer as an unknown one, never a
    // PostgreSQL uuid cast error escaping as a 500.
    if (!isUuid(id)) return NextResponse.json({ error: 'equipment unit not found' }, { status: 404 })
    const { orgId, id: userId } = gate.user

    const unitRes = (await db.execute<{
        id: string; subsidiary_id: string; name: string; description: string | null
        purchase_price: string; acquired_on: string | null; in_service_on: string | null
        serial_number: string | null; fixed_asset_id: string | null
      }>(sql`
      select id, subsidiary_id, name, description, purchase_price::text, acquired_on::text,
             in_service_on::text, serial_number, fixed_asset_id
        from equipment_units where id = ${id} and org_id = ${orgId} limit 1`, 'objects'))
    const unit = unitRes[0]
    if (!unit) return NextResponse.json({ error: 'equipment unit not found' }, { status: 404 })
    if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(unit.subsidiary_id)) {
      return NextResponse.json({ error: 'equipment unit not found' }, { status: 404 })
    }
    if (unit.fixed_asset_id) return NextResponse.json({ error: 'already_capitalized' }, { status: 409 })
    const ownedSub = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and id = ${unit.subsidiary_id}
         and is_active and not is_elimination`, 'objects'))
    if (!ownedSub[0]) {
      return NextResponse.json({ error: 'invalid_subsidiary' }, { status: 422 })
    }
    const acquisitionCostRaw = canonicalDecimal(unit.purchase_price || '0', 4)
    if (acquisitionCostRaw === null) {
      return NextResponse.json({ error: 'acquisition_cost_invalid' }, { status: 422 })
    }
    try {
      normalizeMoney(acquisitionCostRaw)
    } catch {
      return NextResponse.json({ error: 'acquisition_cost_invalid' }, { status: 422 })
    }

    const categoryId = await ensureDefaultCategory(orgId, userId)

    let result: CapitalizationResult
    try {
      result = await db.transaction(async (tx): Promise<CapitalizationResult> => {
        // The source row is the idempotency gate.  A second request waits here,
        // then observes the winner's committed fixed_asset_id instead of
        // creating an orphan that overwrites the link.
        const lockedRes = (await tx.execute<{
          id: string; subsidiary_id: string; name: string; description: string | null
          purchase_price: string; acquired_on: string | null; in_service_on: string | null
          serial_number: string | null; fixed_asset_id: string | null
        }>(sql`
          select id, subsidiary_id, name, description, purchase_price::text, acquired_on::text,
                 in_service_on::text, serial_number, fixed_asset_id
            from equipment_units
           where id = ${id} and org_id = ${orgId}
           for update`, 'objects'))
        const lockedUnit = lockedRes[0]
        if (!lockedUnit) return { kind: 'not_found' }
        if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(lockedUnit.subsidiary_id)) {
          return { kind: 'not_found' }
        }
        if (lockedUnit.fixed_asset_id) return { kind: 'already_capitalized' }

        const lockedOwnedSub = (await tx.execute<{ id: string }>(sql`
          select id from subsidiaries
           where org_id = ${orgId} and id = ${lockedUnit.subsidiary_id}
             and is_active and not is_elimination`, 'objects'))
        if (!lockedOwnedSub[0]) return { kind: 'invalid_subsidiary' }

        const lockedAcquisitionCostRaw = canonicalDecimal(lockedUnit.purchase_price || '0', 4)
        if (lockedAcquisitionCostRaw === null) return { kind: 'acquisition_cost_invalid' }
        let lockedAcquisitionCost: string
        try {
          lockedAcquisitionCost = normalizeMoney(lockedAcquisitionCostRaw)
        } catch {
          return { kind: 'acquisition_cost_invalid' }
        }

        const asset = await createDraftAsset(tx, {
          orgId,
          actorId: userId,
          subsidiaryId: lockedOwnedSub[0]!.id,
          categoryId,
          name: lockedUnit.name,
          description: lockedUnit.description,
          acquisitionCost: lockedAcquisitionCost,
          acquiredOn: lockedUnit.acquired_on,
          inServiceOn: lockedUnit.in_service_on,
          serialNumber: lockedUnit.serial_number,
          provenance: { source: 'equipment_capitalization', equipmentUnitId: id },
        })

        if (lockedUnit.in_service_on) {
          const defaults = (await tx.execute<{
            depreciation_method: string | null
            depreciation_method_id: string | null
            useful_life_months: number | null
            depreciation_units_total: string | null
          }>(sql`
            select depreciation_method, depreciation_method_id, useful_life_months,
                   depreciation_units_total::text as depreciation_units_total
              from fixed_assets where org_id = ${orgId} and id = ${asset.id}`, 'objects'))[0]
          if (!defaults) throw new Error('new equipment asset was not available for service placement')
          const hasUsefulLife = defaults.useful_life_months !== null && defaults.useful_life_months > 0
          const isManualWithoutFormula = !defaults.depreciation_method_id && defaults.depreciation_method === 'manual'
          const hasProductionUnits = !defaults.depreciation_method_id
            && defaults.depreciation_method === 'units_of_production'
            && defaults.depreciation_units_total !== null
            && cmp(defaults.depreciation_units_total, '0') > 0
          if (hasUsefulLife || isManualWithoutFormula || hasProductionUnits) {
            await placeDraftInService(tx, { orgId, assetId: asset.id, actorId: userId })
          }
        }

        const linked = (await tx.execute<{ fixed_asset_id: string }>(sql`
          update equipment_units
             set fixed_asset_id = ${asset.id}, revision = revision + 1, updated_at = now(), updated_by = ${userId}
           where id = ${id} and org_id = ${orgId} and fixed_asset_id is null
           returning fixed_asset_id`, 'objects'))
        // The row lock above makes this path unreachable for a normal race, but
        // keep the invariant explicit: never commit an asset without its source
        // linkage if a trigger/RLS rule causes the CAS to affect zero rows.
        if (!linked[0]) throw new CapitalizationLinkConflict()

        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'equipment_units', ${id}, 'update',
                  ${JSON.stringify({ fixedAssetId: asset.id })}::jsonb, ${userId})`)
        return { kind: 'created', assetId: asset.id, assetNumber: asset.assetNumber }
      })
    } catch (error) {
      // The 0068 storage guards deliberately abort a losing transaction so its
      // asset row cannot survive as an orphan.  Turn that expected race into the
      // route's established conflict response; unrelated failures still surface.
      if (!isCapitalizationRace(error)) throw error
      return NextResponse.json({ error: 'already_capitalized' }, { status: 409 })
    }

    if (result.kind === 'not_found') return NextResponse.json({ error: 'equipment unit not found' }, { status: 404 })
    if (result.kind === 'already_capitalized') return NextResponse.json({ error: 'already_capitalized' }, { status: 409 })
    if (result.kind === 'invalid_subsidiary') return NextResponse.json({ error: 'invalid_subsidiary' }, { status: 422 })
    if (result.kind === 'acquisition_cost_invalid') return NextResponse.json({ error: 'acquisition_cost_invalid' }, { status: 422 })
    return NextResponse.json({ assetId: result.assetId, assetNumber: result.assetNumber })

  },
})
