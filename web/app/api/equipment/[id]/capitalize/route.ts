import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { ensureDefaultCategory } from '../../../assets/categories/_ensure'

export const runtime = 'nodejs'

/**
 * Capitalize an equipment unit as a fixed asset: create the asset prefilled from
 * the unit (cost, dates, serial, subsidiary), link it back onto the unit, and it
 * begins depreciating on the Fixed Assets register. The user refines the asset's
 * category (which drives the depreciation method and tax class) on the asset.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('assets.manage')
  if (gate instanceof NextResponse) return gate
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

  const categoryId = await ensureDefaultCategory(orgId, userId)
  const nextRes = (await db.execute<{ n: number }>(sql`
    select coalesce(max((regexp_replace(asset_number, '\\D', '', 'g'))::int), 0) + 1 as n
      from fixed_assets where org_id = ${orgId} and asset_number ~ '^FA-\\d+$'`))
  const assetNumber = `FA-${String(Number(nextRes.rows[0]?.n ?? 1)).padStart(4, '0')}`
  const status = unit.in_service_on ? 'in_service' : 'draft'

  const assetId = await db.transaction(async (tx) => {
    const ins = (await tx.execute<{ id: string }>(sql`
      insert into fixed_assets
        (org_id, subsidiary_id, category_id, asset_number, name, description, status,
         acquired_on, in_service_on, acquisition_cost, salvage_value, serial_number, created_by, updated_by)
      values (${orgId}, ${unit.subsidiary_id}, ${categoryId}, ${assetNumber}, ${unit.name},
              ${unit.description}, ${status}, ${unit.acquired_on}, ${unit.in_service_on},
              ${unit.purchase_price || '0'}, '0', ${unit.serial_number}, ${userId}, ${userId})
      returning id`))
    const newId = ins.rows[0].id
    await tx.execute(sql`
      update equipment_units set fixed_asset_id = ${newId}, updated_at = now(), updated_by = ${userId}
       where id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'fixed_assets', ${newId}, 'insert',
              ${JSON.stringify({ capitalizedFromEquipment: id, assetNumber })}::jsonb, ${userId})`)
    return newId
  })

  return NextResponse.json({ assetId, assetNumber })
}
