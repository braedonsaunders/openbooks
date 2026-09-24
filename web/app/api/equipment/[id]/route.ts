import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { canonicalDecimal, compareDecimal } from '../../../../lib/exact-decimal'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { loadEquipment, loadEquipmentInWrite } from '../_lib'

function text(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null }
function bad(error: string) { return NextResponse.json({ error, code: error }, { status: 422 }) }

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.read', 'equipment')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  // The loader checks the scope first, on the locked unit row: an
  // out-of-scope unit answers exactly like a missing one, with no post-hoc
  // check for a concurrent rehome to race.
  const data = isUuid(id) ? await loadEquipment(id, gate.user.orgId, gate.allowedSubsidiaryIds) : null
  if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json(data)
}

interface EquipmentUnitRow {
  id: string
  subsidiary_id: string
  unit_number: string
  name: string
  description: string | null
  status: string
  charge_item_id: string | null
  fixed_asset_id: string | null
  rate_book_id: string | null
  purchase_price: string
  acquired_on: string | null
  in_service_on: string | null
  serial_number: string | null
  capacity_quantity: string | null
  capacity_unit: string | null
  revision: number
}

/** A stale write names its remedy: the record moved, so reload and reapply. */
function staleRevision() {
  return NextResponse.json(
    {
      error: 'This equipment changed since you loaded it — reload the record and reapply your change',
      code: 'stale_revision',
    },
    { status: 409 },
  )
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'equipment')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data)
  // Mandatory optimistic-concurrency token: the caller echoes the revision it
  // loaded. Without it a stale full-form write silently overwrites the
  // winner's columns, which is exactly the loss this fence exists to refuse.
  const revision = (body as { revision?: unknown }).revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return bad('revision_required')
  }
  try {
    return await db.transaction(async (tx) => {
      // Lock first: every value below — the revision comparison, the
      // effective-value validation, the changed-field diff, and the audit
      // before-image — reads the locked row, never a pre-transaction one.
      const locked = ((await tx.execute(sql`
        select *
          from equipment_units
         where id = ${id} and org_id = ${gate.user.orgId}
         for update`)))
      const current = locked.rows[0] as EquipmentUnitRow | undefined
      if (!current) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(current.subsidiary_id))) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      }
      // Scope precedes the revision comparison so a rehomed unit remains
      // indistinguishable from a missing row, even with a stale token.
      if (Number(current.revision) !== revision) return staleRevision()

      // Effective values: body-supplied fields over the locked row. Only
      // supplied references are re-validated — a previously valid link the
      // caller did not touch is not the caller's to break.
      if (body.fixedAssetId !== undefined) {
        const currentId = current.fixed_asset_id ? String(current.fixed_asset_id) : null
        const nextId = text(body.fixedAssetId)
        if (currentId !== nextId && !(await isFeatureEnabled(gate.user.orgId, 'fixedAssets'))) {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
      }
      if (body.rateBookId !== undefined) {
        const currentId = current.rate_book_id ? String(current.rate_book_id) : null
        const nextId = text(body.rateBookId)
        if (currentId !== nextId && !(await isFeatureEnabled(gate.user.orgId, 'projects'))) {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
      }
      const status = body.status !== undefined ? body.status : current.status
      if (typeof status !== 'string' || !['draft','active','inactive','retired'].includes(status)) return bad('invalid_status')
      const name = body.name !== undefined ? text(body.name) : current.name
      if (status === 'active' && (!name || name === 'New equipment unit')) return bad('name_required')
      const chargeItemId = body.chargeItemId !== undefined ? text(body.chargeItemId) : current.charge_item_id
      if (status === 'active' && !chargeItemId) return bad('charge_item_required')
      // fixedAssetId/rateBookId get an isUuid check below; subsidiary and
      // charge references need the same gate or a malformed value throws
      // 22P02 (500).
      if (body.chargeItemId !== undefined && chargeItemId && (typeof chargeItemId !== 'string' || !isUuid(chargeItemId))) {
        return bad('charge_item_not_found')
      }
      if (body.chargeItemId !== undefined && chargeItemId) {
        const item = ((await tx.execute(sql`select 1 from items where id = ${chargeItemId} and org_id = ${gate.user.orgId} and kind = 'equipment_charge' and is_active`)))
        if (!item.rows[0]) return bad('charge_item_not_found')
      }
      const subsidiaryId = body.subsidiaryId !== undefined ? text(body.subsidiaryId) : current.subsidiary_id
      if (body.subsidiaryId !== undefined) {
        if (subsidiaryId && (typeof subsidiaryId !== 'string' || !isUuid(subsidiaryId))) return bad('invalid_subsidiary')
        const sub = ((await tx.execute(sql`select 1 from subsidiaries where id = ${subsidiaryId} and org_id = ${gate.user.orgId} and is_active and not is_elimination`)))
        if (!sub.rows[0] || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(subsidiaryId)))) {
          return bad('invalid_subsidiary')
        }
      }
      const fixedAssetId = body.fixedAssetId !== undefined ? text(body.fixedAssetId) : current.fixed_asset_id
      const rateBookId = body.rateBookId !== undefined ? text(body.rateBookId) : current.rate_book_id
      for (const [value, label] of [[fixedAssetId, 'Fixed asset'], [rateBookId, 'Rate book']] as const) {
        if (value !== undefined && text(value) && !isUuid(text(value)!)) return bad(label === 'Fixed asset' ? 'invalid_fixed_asset' : 'invalid_rate_book')
      }
      // A write touching either side of the asset link must leave a
      // consistent pair: linking across entities is refused, and moving the
      // unit out from under a live link is refused. A write touching
      // neither side cannot introduce a mismatch, so the locked pair stands.
      if (body.fixedAssetId !== undefined && fixedAssetId) {
        const found = ((await tx.execute(sql`select subsidiary_id from fixed_assets where id = ${fixedAssetId} and org_id = ${gate.user.orgId}`)))
        if (!found.rows[0]) return bad('fixed_asset_not_found')
        if (String((found.rows[0] as { subsidiary_id: string }).subsidiary_id) !== String(subsidiaryId)) {
          return bad('subsidiary_mismatch')
        }
      }
      if (body.fixedAssetId === undefined && body.subsidiaryId !== undefined && fixedAssetId) {
        const linked = ((await tx.execute(sql`select subsidiary_id from fixed_assets where id = ${fixedAssetId} and org_id = ${gate.user.orgId}`)))
        if (linked.rows[0] && String((linked.rows[0] as { subsidiary_id: string }).subsidiary_id) !== String(subsidiaryId)) {
          return bad('subsidiary_mismatch')
        }
      }
      if (body.rateBookId !== undefined && rateBookId) {
        const found = ((await tx.execute(sql`select 1 from item_rate_books where id = ${rateBookId} and org_id = ${gate.user.orgId} and is_active`)))
        if (!found.rows[0]) return bad('rate_book_not_found')
      }
      let purchasePrice = normalizeMoney(String(current.purchase_price))
      if (body.purchasePrice !== undefined) {
        const purchasePriceRaw = canonicalDecimal(body.purchasePrice || '0', 4)
        if (purchasePriceRaw === null || wholeDigits(purchasePriceRaw) > 15 || compareDecimal(purchasePriceRaw, '0') < 0) {
          return bad(purchasePriceRaw === null || wholeDigits(purchasePriceRaw) > 15 ? 'purchase_price_invalid' : 'purchase_price_negative')
        }
        purchasePrice = normalizeMoney(purchasePriceRaw)
      }
      let capacityQuantity: string | null = current.capacity_quantity == null ? null : normalizeMoney(String(current.capacity_quantity))
      if (body.capacityQuantity !== undefined) {
        const capacityInput = text(body.capacityQuantity)
        const capacityRaw = capacityInput ? canonicalDecimal(capacityInput, 4) : null
        if (capacityInput && (capacityRaw === null || wholeDigits(capacityRaw) > 15)) return bad('capacity_invalid')
        try {
          capacityQuantity = capacityRaw === null ? null : normalizeMoney(capacityRaw)
          if (capacityQuantity && cmp(capacityQuantity, '0') <= 0) return bad('capacity_not_positive')
        } catch { return bad('capacity_invalid') }
      }
      const acquiredOn = body.acquiredOn !== undefined ? text(body.acquiredOn) : current.acquired_on
      const inServiceOn = body.inServiceOn !== undefined ? text(body.inServiceOn) : current.in_service_on
      // Strict calendar boundary: a shape-valid non-day such as February 30
      // would otherwise reach the DATE columns and surface as a 500 from
      // PostgreSQL instead of failing closed here. Only body-supplied values
      // are checked — stored values already passed this gate on the way in.
      if (body.acquiredOn !== undefined && acquiredOn !== null && !isIsoCalendarDate(acquiredOn)) return bad('acquired_on_invalid')
      if (body.inServiceOn !== undefined && inServiceOn !== null && !isIsoCalendarDate(inServiceOn)) return bad('in_service_on_invalid')
      if ((body.acquiredOn !== undefined || body.inServiceOn !== undefined) && acquiredOn && inServiceOn && String(inServiceOn) < String(acquiredOn)) {
        return bad('in_service_before_acquisition')
      }

      // Write only fields the caller actually changed: a concurrent edit to
      // a different column keeps its value even when both writers loaded the
      // same base revision — and the fence above refuses the genuinely stale
      // (same-column) collision instead of silently losing it.
      const same = (a: string | null, b: string | null): boolean => (a ?? null) === (b ?? null)
      const sets: { column: string; value: unknown }[] = []
      const consider = (column: string, next: unknown, base: unknown, supplied: boolean): void => {
        if (!supplied) return
        if (same(next as string | null, base as string | null)) return
        sets.push({ column, value: next })
      }
      consider('name', name ?? 'New equipment unit', current.name, body.name !== undefined)
      {
        const supplied = body.unitNumber !== undefined ? text(body.unitNumber) : null
        if (supplied) consider('unit_number', supplied, current.unit_number, true)
      }
      consider('description', body.description !== undefined ? text(body.description) : current.description, current.description, body.description !== undefined)
      consider('status', status, current.status, body.status !== undefined)
      consider('subsidiary_id', subsidiaryId, current.subsidiary_id, body.subsidiaryId !== undefined)
      consider('charge_item_id', chargeItemId, current.charge_item_id, body.chargeItemId !== undefined)
      consider('fixed_asset_id', fixedAssetId, current.fixed_asset_id, body.fixedAssetId !== undefined)
      consider('rate_book_id', rateBookId, current.rate_book_id, body.rateBookId !== undefined)
      consider('purchase_price', purchasePrice, normalizeMoney(String(current.purchase_price)), body.purchasePrice !== undefined)
      consider('acquired_on', acquiredOn, current.acquired_on, body.acquiredOn !== undefined)
      consider('in_service_on', inServiceOn, current.in_service_on, body.inServiceOn !== undefined)
      consider('serial_number', body.serialNumber !== undefined ? text(body.serialNumber) : current.serial_number, current.serial_number, body.serialNumber !== undefined)
      consider('capacity_quantity', capacityQuantity, current.capacity_quantity == null ? null : normalizeMoney(String(current.capacity_quantity)), body.capacityQuantity !== undefined)
      consider('capacity_unit', body.capacityUnit !== undefined ? text(body.capacityUnit) : current.capacity_unit, current.capacity_unit, body.capacityUnit !== undefined)
      if (sets.length === 0) {
        // A replay of the stored values: idempotent no-op, no new revision
        // and no audit row for a write that changed nothing.
        return NextResponse.json(await loadEquipmentInWrite(tx, id, gate.user.orgId, gate.allowedSubsidiaryIds))
      }
      const updated = await tx.execute(sql`
        update equipment_units
           set ${sql.join(
             [
               ...sets.map((s) => sql`${sql.raw(s.column)} = ${s.value}`),
               sql`revision = revision + 1`,
               sql`updated_at = now()`,
               sql`updated_by = ${gate.user.id}`,
             ],
             sql`, `,
           )}
         where id = ${id} and org_id = ${gate.user.orgId} and revision = ${Number(current.revision)}
         returning *`)
      // The lock makes this unreachable for a normal race, but the count is
      // the claim: never report success for a write no read can observe.
      if (updated.rows.length !== 1) return staleRevision()
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'equipment_units', ${id}, 'update',
                ${JSON.stringify({ before: current, after: updated.rows[0] })}::jsonb, ${gate.user.id})
      `)
      return NextResponse.json(await loadEquipmentInWrite(tx, id, gate.user.orgId, gate.allowedSubsidiaryIds))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('equipment_units_org_number')) return bad('equipment_number_exists')
    if (message.includes('equipment_units_fixed_asset')) return bad('fixed_asset_already_linked')
    throw error
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'equipment')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return db.transaction(async (tx) => {
    // The draft check happens under the row lock inside the same transaction
    // as the delete: a concurrent activation can no longer slip between the
    // check and the write and get deleted. The delete predicate repeats the
    // status so the affected-row count is the claim — zero rows means the
    // race was lost, and the re-read names whether the unit is gone (404)
    // or merely no longer a draft (409) instead of auditing a stale success.
    const locked = ((await tx.execute(sql`
      select status, subsidiary_id from equipment_units
       where id = ${id} and org_id = ${gate.user.orgId}
       for update`)))
    const row = locked.rows[0] as { status: string; subsidiary_id: string } | undefined
    if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(row.subsidiary_id))) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    if (row.status !== 'draft') return NextResponse.json({ error: 'draft_only_delete' }, { status: 409 })
    const used = ((await tx.execute(sql`select 1 from document_lines where equipment_unit_id = ${id} and org_id = ${gate.user.orgId} limit 1`)))
    if (used.rows[0]) return NextResponse.json({ error: 'charge_history_delete' }, { status: 409 })
    const deleted = await tx.execute(sql`
      delete from equipment_units
       where id = ${id} and org_id = ${gate.user.orgId} and status = 'draft'
       returning id`)
    if (deleted.rows.length !== 1) {
      const again = ((await tx.execute(sql`select status from equipment_units where id = ${id} and org_id = ${gate.user.orgId}`)))
      if (!again.rows[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      return NextResponse.json({ error: 'draft_only_delete' }, { status: 409 })
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'equipment_units', ${id}, 'delete',
              ${JSON.stringify({ before: row })}::jsonb, ${gate.user.id})
    `)
    return NextResponse.json({ ok: true })
  })
}
