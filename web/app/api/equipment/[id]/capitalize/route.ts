import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../../lib/features'
import { ensureDefaultCategory } from '../../../assets/categories/_ensure'

export const runtime = 'nodejs'

type CapitalizationResult =
  | { kind: 'created'; assetId: string; assetNumber: string }
  | { kind: 'already_capitalized' }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
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
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'equipment')
  if (gate instanceof NextResponse) return gate
  // Capitalize writes a fixed_assets row. Equipment being on is not enough —
  // turning Fixed Assets off must stop new register rows without touching
  // units that already exist.
  if (!(await isFeatureEnabled(gate.user.orgId, 'fixedAssets'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const { id } = await params
  const { orgId, id: userId } = gate.user

  const unitRes = (await db.execute<{
      id: string; subsidiary_id: string; name: string; description: string | null
      purchase_price: string; acquired_on: string | null; in_service_on: string | null
      serial_number: string | null; fixed_asset_id: string | null
    }>(sql`
    select id, subsidiary_id, name, description, purchase_price::text, acquired_on::text,
           in_service_on::text, serial_number, fixed_asset_id
      from equipment_units where id = ${id} and org_id = ${orgId} limit 1`))
  const unit = unitRes.rows[0]
  if (!unit) return NextResponse.json({ error: 'equipment unit not found' }, { status: 404 })
  if (unit.fixed_asset_id) return NextResponse.json({ error: 'already_capitalized' }, { status: 409 })
  if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(unit.subsidiary_id)) {
    return NextResponse.json({ error: 'forbidden subsidiary' }, { status: 403 })
  }
  const ownedSub = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${orgId} and id = ${unit.subsidiary_id}
       and is_active and not is_elimination`))
  if (!ownedSub.rows[0]) {
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
         for update`))
      const lockedUnit = lockedRes.rows[0]
      if (!lockedUnit) return { kind: 'not_found' }
      if (lockedUnit.fixed_asset_id) return { kind: 'already_capitalized' }
      if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(lockedUnit.subsidiary_id)) {
        return { kind: 'forbidden' }
      }

      const lockedOwnedSub = (await tx.execute<{ id: string }>(sql`
        select id from subsidiaries
         where org_id = ${orgId} and id = ${lockedUnit.subsidiary_id}
           and is_active and not is_elimination`))
      if (!lockedOwnedSub.rows[0]) return { kind: 'invalid_subsidiary' }

      const lockedAcquisitionCostRaw = canonicalDecimal(lockedUnit.purchase_price || '0', 4)
      if (lockedAcquisitionCostRaw === null) return { kind: 'acquisition_cost_invalid' }
      let lockedAcquisitionCost: string
      try {
        lockedAcquisitionCost = normalizeMoney(lockedAcquisitionCostRaw)
      } catch {
        return { kind: 'acquisition_cost_invalid' }
      }

      // Serialize the org-wide advisory allocation with every capitalization
      // route.  The unique constraint remains the final authority for other
      // fixed-asset writers, while this fence keeps max()+1 deterministic here.
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`equipment-capitalization:${orgId}`}, 0)
        )`)
      const lockedNextRes = (await tx.execute<{ n: number }>(sql`
        select coalesce(max((regexp_replace(asset_number, '\\D', '', 'g'))::int), 0) + 1 as n
          from fixed_assets
         where org_id = ${orgId} and asset_number ~ '^FA-\\d+$'`))
      const lockedAssetNumber = `FA-${String(Number(lockedNextRes.rows[0]?.n ?? 1)).padStart(4, '0')}`
      const lockedStatus = lockedUnit.in_service_on ? 'in_service' : 'draft'

      const ins = (await tx.execute<{ id: string }>(sql`
        insert into fixed_assets
          (org_id, subsidiary_id, category_id, asset_number, name, description, status,
           acquired_on, in_service_on, acquisition_cost, salvage_value, serial_number, created_by, updated_by)
        values (${orgId}, ${lockedOwnedSub.rows[0]!.id}, ${categoryId}, ${lockedAssetNumber}, ${lockedUnit.name},
                ${lockedUnit.description}, ${lockedStatus}, ${lockedUnit.acquired_on}, ${lockedUnit.in_service_on},
                ${lockedAcquisitionCost}, '0', ${lockedUnit.serial_number}, ${userId}, ${userId})
        returning id`))
      const newId = ins.rows[0]!.id
      const linked = (await tx.execute<{ fixed_asset_id: string }>(sql`
        update equipment_units
           set fixed_asset_id = ${newId}, updated_at = now(), updated_by = ${userId}
         where id = ${id} and org_id = ${orgId} and fixed_asset_id is null
         returning fixed_asset_id`))
      // The row lock above makes this path unreachable for a normal race, but
      // keep the invariant explicit: never commit an asset without its source
      // linkage if a trigger/RLS rule causes the CAS to affect zero rows.
      if (!linked.rows[0]) throw new CapitalizationLinkConflict()

      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'fixed_assets', ${newId}, 'insert',
                ${JSON.stringify({ capitalizedFromEquipment: id, assetNumber: lockedAssetNumber })}::jsonb, ${userId})`)
      return { kind: 'created', assetId: newId, assetNumber: lockedAssetNumber }
    })
  } catch (error) {
    // The 0068 storage guards deliberately abort a losing transaction so its
    // asset row cannot survive as an orphan.  Turn that expected race into the
    // route's established conflict response; unrelated failures still surface.
    if (!isCapitalizationRace(error)) throw error
    const winner = (await db.execute<{ fixed_asset_id: string | null }>(sql`
      select fixed_asset_id
        from equipment_units
       where id = ${id} and org_id = ${orgId}
       limit 1`)).rows[0]
    return NextResponse.json(
      { error: winner?.fixed_asset_id ? 'already_capitalized' : 'capitalization_conflict' },
      { status: 409 },
    )
  }

  if (result.kind === 'not_found') return NextResponse.json({ error: 'equipment unit not found' }, { status: 404 })
  if (result.kind === 'already_capitalized') return NextResponse.json({ error: 'already_capitalized' }, { status: 409 })
  if (result.kind === 'forbidden') return NextResponse.json({ error: 'forbidden subsidiary' }, { status: 403 })
  if (result.kind === 'invalid_subsidiary') return NextResponse.json({ error: 'invalid_subsidiary' }, { status: 422 })
  if (result.kind === 'acquisition_cost_invalid') return NextResponse.json({ error: 'acquisition_cost_invalid' }, { status: 422 })
  return NextResponse.json({ assetId: result.assetId, assetNumber: result.assetNumber })
}
