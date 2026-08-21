import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { fromUnits, toUnits } from '@openbooks/engine/src/money.ts'
import {
  adjustInventory,
  buildAssembly,
  issueInventory,
  postLandedCostVoucher,
  receiveInventory,
  reverseInventoryMovement,
  transferInventory,
  InventoryError,
} from '@openbooks/engine/src/inventory.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Body {
  action?: 'receive' | 'issue' | 'adjust' | 'transfer' | 'build' | 'landed' | 'reverse'
  movementId?: string
  itemId?: string
  stockLocationId?: string
  toStockLocationId?: string
  quantity?: string
  unitCost?: string
  offsetAccountId?: string
  basis?: 'value' | 'quantity'
  subsidiaryId?: string
  date?: string
  memo?: string
  lotId?: string
  serialId?: string
}

function num(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  try {
    return fromUnits(toUnits(v))
  } catch {
    return null
  }
}

/**
 * Post an inventory movement through the kernel: receive (DR inventory / CR
 * offset), issue (DR COGS / CR inventory), or adjust (± vs the adjustment
 * account). Costing follows the item's profile.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  if (!(await isFeatureEnabled(user.orgId, 'inventory'))) {
    return NextResponse.json({ error: 'feature disabled' }, { status: 404 })
  }

  const body = (await req.json().catch(() => ({}))) as Body
  if (!body.action || !['receive', 'issue', 'adjust', 'transfer', 'build', 'landed', 'reverse'].includes(body.action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 422 })
  }
  if (body.action === 'reverse') {
    if (!body.movementId || !isUuid(body.movementId)) {
      return NextResponse.json({ error: 'movement required' }, { status: 422 })
    }
    if (!body.date || !DATE_RE.test(body.date)) {
      return NextResponse.json({ error: 'reversal date required' }, { status: 422 })
    }
    if (typeof body.memo !== 'string' || body.memo.trim().length < 5 || body.memo.trim().length > 500) {
      return NextResponse.json({ error: 'reversal reason must be between 5 and 500 characters' }, { status: 422 })
    }
    try {
      const res = await reverseInventoryMovement(user.orgId, user.id, {
        movementId: body.movementId,
        reversalDate: body.date,
        reason: body.memo,
      })
      return NextResponse.json({ ok: true, ...res })
    } catch (e: unknown) {
      const status = e instanceof InventoryError ? 422 : 500
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status })
    }
  }
  if (!body.itemId || !isUuid(body.itemId)) return NextResponse.json({ error: 'item required' }, { status: 422 })
  if (!body.stockLocationId || !isUuid(body.stockLocationId)) {
    return NextResponse.json({ error: 'stock location required' }, { status: 422 })
  }
  const quantity = num(body.quantity)
  if (quantity === null || toUnits(quantity) === 0n) {
    return NextResponse.json({ error: 'quantity required' }, { status: 422 })
  }
  const date = body.date && DATE_RE.test(body.date) ? body.date : await businessToday(user.orgId)

  // Default to the org's primary/first subsidiary when the caller didn't scope one.
  let subsidiaryId = body.subsidiaryId
  if (!subsidiaryId || !isUuid(subsidiaryId)) {
    const r = (await db.execute<{ id: string }>(
      sql`select id from subsidiaries where org_id = ${user.orgId} order by created_at limit 1`,
    ))
    subsidiaryId = r.rows[0]?.id
    if (!subsidiaryId) return NextResponse.json({ error: 'no subsidiary configured' }, { status: 422 })
  }
  if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
    return NextResponse.json({ error: 'subsidiary not permitted' }, { status: 403 })
  }

  try {
    if (body.action === 'receive') {
      const unitCost = num(body.unitCost)
      if (unitCost === null) return NextResponse.json({ error: 'unit cost required' }, { status: 422 })
      if (!body.offsetAccountId || !isUuid(body.offsetAccountId)) {
        return NextResponse.json({ error: 'offset account required' }, { status: 422 })
      }
      const res = await receiveInventory(user.orgId, user.id, {
        itemId: body.itemId,
        stockLocationId: body.stockLocationId,
        quantity,
        unitCost,
        subsidiaryId,
        offsetAccountId: body.offsetAccountId,
        date,
        lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
        serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
        memo: body.memo ?? null,
      })
      return NextResponse.json({ ok: true, ...res })
    }
    if (body.action === 'build') {
      const res = await buildAssembly(user.orgId, user.id, {
        assemblyItemId: body.itemId,
        quantity,
        stockLocationId: body.stockLocationId,
        subsidiaryId,
        date,
        memo: body.memo ?? null,
      })
      return NextResponse.json({ ok: true, ...res })
    }
    if (body.action === 'landed') {
      if (!body.offsetAccountId || !isUuid(body.offsetAccountId)) {
        return NextResponse.json({ error: 'freight account required' }, { status: 422 })
      }
      const res = await postLandedCostVoucher(user.orgId, user.id, {
        amount: quantity,
        basis: body.basis === 'quantity' ? 'quantity' : 'value',
        freightAccountId: body.offsetAccountId,
        subsidiaryId,
        voucherDate: date,
        memo: body.memo ?? null,
        targets: [{ itemId: body.itemId, stockLocationId: body.stockLocationId }],
      })
      return NextResponse.json({ ok: true, id: res.id, documentNumber: res.documentNumber, entryId: res.entryId, value: quantity })
    }
    if (body.action === 'transfer') {
      if (!body.toStockLocationId || !isUuid(body.toStockLocationId)) {
        return NextResponse.json({ error: 'destination location required' }, { status: 422 })
      }
      const res = await transferInventory(user.orgId, user.id, {
        itemId: body.itemId,
        fromStockLocationId: body.stockLocationId,
        toStockLocationId: body.toStockLocationId,
        quantity,
        lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
        serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
        subsidiaryId,
        date,
        memo: body.memo ?? null,
      })
      return NextResponse.json({ ok: true, ...res })
    }
    if (body.action === 'issue') {
      const res = await issueInventory(user.orgId, user.id, {
        itemId: body.itemId,
        stockLocationId: body.stockLocationId,
        quantity,
        subsidiaryId,
        offsetAccountId: body.offsetAccountId && isUuid(body.offsetAccountId) ? body.offsetAccountId : undefined,
        date,
        lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
        serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
        memo: body.memo ?? null,
      })
      return NextResponse.json({ ok: true, ...res })
    }
    // adjust: quantity is a signed delta
    const res = await adjustInventory(user.orgId, user.id, {
      itemId: body.itemId,
      stockLocationId: body.stockLocationId,
      quantityDelta: quantity,
      lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
      serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
      subsidiaryId,
      date,
      unitCost: num(body.unitCost) ?? undefined,
      memo: body.memo ?? null,
    })
    return NextResponse.json({ ok: true, ...res })
  } catch (e: unknown) {
    const status = e instanceof InventoryError ? 422 : 500
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status })
  }
}
