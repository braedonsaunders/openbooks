import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  adjustInventory,
  issueInventory,
  receiveInventory,
  InventoryError,
} from '@openbooks/engine/src/inventory.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Body {
  action?: 'receive' | 'issue' | 'adjust'
  itemId?: string
  stockLocationId?: string
  quantity?: string
  unitCost?: string
  offsetAccountId?: string
  subsidiaryId?: string
  date?: string
  memo?: string
}

function num(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const n = Number(v)
  return Number.isFinite(n) ? String(v) : null
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

  const body = (await req.json().catch(() => ({}))) as Body
  if (!body.action || !['receive', 'issue', 'adjust'].includes(body.action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 422 })
  }
  if (!body.itemId || !isUuid(body.itemId)) return NextResponse.json({ error: 'item required' }, { status: 422 })
  if (!body.stockLocationId || !isUuid(body.stockLocationId)) {
    return NextResponse.json({ error: 'stock location required' }, { status: 422 })
  }
  const quantity = num(body.quantity)
  if (quantity === null || Number(quantity) === 0) {
    return NextResponse.json({ error: 'quantity required' }, { status: 422 })
  }
  const date = body.date && DATE_RE.test(body.date) ? body.date : new Date().toISOString().slice(0, 10)

  // Default to the org's primary/first subsidiary when the caller didn't scope one.
  let subsidiaryId = body.subsidiaryId
  if (!subsidiaryId || !isUuid(subsidiaryId)) {
    const r = (await db.execute(
      sql`select id from subsidiaries where org_id = ${user.orgId} order by created_at limit 1`,
    )) as unknown as { rows: { id: string }[] }
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
        memo: body.memo ?? null,
      })
      return NextResponse.json({ ok: true, ...res })
    }
    // adjust: quantity is a signed delta
    const res = await adjustInventory(user.orgId, user.id, {
      itemId: body.itemId,
      stockLocationId: body.stockLocationId,
      quantityDelta: quantity,
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
