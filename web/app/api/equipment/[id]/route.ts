import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { canonicalDecimal, compareDecimal } from '../../../../lib/exact-decimal'
import { loadEquipment } from '../_lib'

function text(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null }
function bad(error: string) { return NextResponse.json({ error }, { status: 422 }) }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.read', 'equipment')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const data = isUuid(id) ? await loadEquipment(id, gate.user.orgId) : null
  if (!data || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(data.unit.subsidiary_id)))) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json(data)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'equipment')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const current = (await db.execute(sql`select * from equipment_units where id = ${id} and org_id = ${gate.user.orgId}`)) as any
  if (!current.rows[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(current.rows[0].subsidiary_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const body = await req.json() as any
  const status = body.status ?? current.rows[0].status
  if (!['draft','active','inactive','retired'].includes(status)) return bad('invalid_status')
  const name = body.name !== undefined ? text(body.name) : current.rows[0].name
  if (status === 'active' && (!name || name === 'New equipment unit')) return bad('name_required')
  const chargeItemId = body.chargeItemId !== undefined ? text(body.chargeItemId) : current.rows[0].charge_item_id
  if (status === 'active' && !chargeItemId) return bad('charge_item_required')
  if (chargeItemId) {
    const item = (await db.execute(sql`select 1 from items where id = ${chargeItemId} and org_id = ${gate.user.orgId} and kind = 'equipment_charge' and is_active`)) as any
    if (!item.rows[0]) return bad('charge_item_not_found')
  }
  const subsidiaryId = body.subsidiaryId !== undefined ? text(body.subsidiaryId) : current.rows[0].subsidiary_id
  const sub = (await db.execute(sql`select 1 from subsidiaries where id = ${subsidiaryId} and org_id = ${gate.user.orgId} and is_active and not is_elimination`)) as any
  if (!sub.rows[0] || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(subsidiaryId)))) return bad('invalid_subsidiary')
  const fixedAssetId = body.fixedAssetId !== undefined ? text(body.fixedAssetId) : current.rows[0].fixed_asset_id
  const rateBookId = body.rateBookId !== undefined ? text(body.rateBookId) : current.rows[0].rate_book_id
  for (const [value, label] of [[fixedAssetId, 'Fixed asset'], [rateBookId, 'Rate book']] as const) {
    if (value !== undefined && text(value) && !isUuid(text(value)!)) return bad(label === 'Fixed asset' ? 'invalid_fixed_asset' : 'invalid_rate_book')
  }
  if (fixedAssetId) {
    const found = (await db.execute(sql`select subsidiary_id from fixed_assets where id = ${fixedAssetId} and org_id = ${gate.user.orgId}`)) as any
    if (!found.rows[0]) return bad('fixed_asset_not_found')
    if (String(found.rows[0].subsidiary_id) !== String(subsidiaryId)) return bad('subsidiary_mismatch')
  }
  if (rateBookId) {
    const found = (await db.execute(sql`select 1 from item_rate_books where id = ${rateBookId} and org_id = ${gate.user.orgId} and is_active`)) as any
    if (!found.rows[0]) return bad('rate_book_not_found')
  }
  const purchasePriceRaw = body.purchasePrice !== undefined
    ? canonicalDecimal(body.purchasePrice || '0', 4)
    : String(current.rows[0].purchase_price)
  if (purchasePriceRaw === null || compareDecimal(purchasePriceRaw, '0') < 0) {
    return bad(purchasePriceRaw === null ? 'purchase_price_invalid' : 'purchase_price_negative')
  }
  const purchasePrice = normalizeMoney(purchasePriceRaw)
  const capacityInput = body.capacityQuantity !== undefined ? text(body.capacityQuantity) : undefined
  const capacityRaw = capacityInput ? canonicalDecimal(capacityInput, 4) : null
  if (capacityInput && capacityRaw === null) return bad('capacity_invalid')
  let capacityQuantity: string | null = null
  try {
    capacityQuantity = capacityRaw === null ? null : normalizeMoney(capacityRaw)
    if (capacityQuantity && cmp(capacityQuantity, '0') <= 0) return bad('capacity_not_positive')
  } catch { return bad('capacity_invalid') }
  const acquiredOn = body.acquiredOn !== undefined ? text(body.acquiredOn) : current.rows[0].acquired_on
  const inServiceOn = body.inServiceOn !== undefined ? text(body.inServiceOn) : current.rows[0].in_service_on
  if (acquiredOn && inServiceOn && String(inServiceOn) < String(acquiredOn)) return bad('in_service_before_acquisition')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update equipment_units set name = ${name ?? 'New equipment unit'},
          unit_number = ${body.unitNumber !== undefined ? text(body.unitNumber) ?? sql`unit_number` : sql`unit_number`},
          description = ${body.description !== undefined ? text(body.description) : sql`description`}, status = ${status},
          subsidiary_id = ${subsidiaryId}, charge_item_id = ${chargeItemId},
          fixed_asset_id = ${fixedAssetId}, rate_book_id = ${rateBookId},
          purchase_price = ${purchasePrice}, acquired_on = ${acquiredOn}, in_service_on = ${inServiceOn},
          serial_number = ${body.serialNumber !== undefined ? text(body.serialNumber) : sql`serial_number`},
          capacity_quantity = ${body.capacityQuantity !== undefined ? capacityQuantity : sql`capacity_quantity`},
          capacity_unit = ${body.capacityUnit !== undefined ? text(body.capacityUnit) : sql`capacity_unit`},
          updated_at = now(), updated_by = ${gate.user.id} where id = ${id} and org_id = ${gate.user.orgId}
      `)
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'equipment_units', ${id}, 'update',
                ${JSON.stringify({ before: current.rows[0], requested: body })}::jsonb, ${gate.user.id})
      `)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('equipment_units_org_number')) return bad('equipment_number_exists')
    if (message.includes('equipment_units_fixed_asset')) return bad('fixed_asset_already_linked')
    throw error
  }
  const after = await loadEquipment(id, gate.user.orgId)
  return NextResponse.json(after)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'equipment')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const current = (await db.execute(sql`select status, subsidiary_id from equipment_units where id = ${id} and org_id = ${gate.user.orgId}`)) as any
  if (!current.rows[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(current.rows[0].subsidiary_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (current.rows[0].status !== 'draft') return NextResponse.json({ error: 'draft_only_delete' }, { status: 409 })
  const used = (await db.execute(sql`select 1 from document_lines where equipment_unit_id = ${id} and org_id = ${gate.user.orgId} limit 1`)) as any
  if (used.rows[0]) return NextResponse.json({ error: 'charge_history_delete' }, { status: 409 })
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from equipment_units where id = ${id} and org_id = ${gate.user.orgId}`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'equipment_units', ${id}, 'delete',
              ${JSON.stringify({ before: current.rows[0] })}::jsonb, ${gate.user.id})
    `)
  })
  return NextResponse.json({ ok: true })
}
