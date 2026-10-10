import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { lineRequiresReceipt } from '@openbooks/engine/src/records/stock-receipt.ts'
import { InventoryError, InventoryOwnershipError } from '@openbooks/engine/src/inventory/contracts.ts'
import { resolveDefaultWarehouse, WarehouseRefusal } from '@openbooks/engine/src/inventory/warehouses.ts'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { can, guardSubsidiaryScope } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import { unexpectedServerError } from '../../../../../lib/api/unexpected'
import { ConversionError, receivePurchaseOrder } from '../../../../../lib/order-cycle'
import { fromQuantityUnits, toQuantityUnits } from '../../../../../lib/order-cycle-math'

export const runtime = 'nodejs'

const params = z.object({ id: z.string().uuid() })

const receiveLineBody = z.object({
  sourceLineId: z.string().uuid(),
  quantity: z.string().min(1).max(50),
}).strict()

const receiveBody = z.object({
  receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(receiveLineBody).min(1),
  idempotencyKey: z.string().min(1).max(500).optional(),
}).strict()

type ReceiveAuthz = Parameters<typeof guardSubsidiaryScope>[0] & {
  user: { orgId: string; id: string }
}

/** The source must be this org's purchase order inside the caller's scope. */
async function scopedSource(authz: ReceiveAuthz, id: string) {
  const owns = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = 'purchase_order' and org_id = ${authz.user.orgId}`,
  ))
  const source = owns.rows[0]
  if (!source) return { denied: notFound('record') as NextResponse }
  const denied = guardSubsidiaryScope(authz, source.subsidiaryId)
  if (denied) return { denied }
  return { source }
}

function conversionResponse(error: ConversionError) {
  return NextResponse.json(
    {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
    { status: error.status },
  )
}

/**
 * GET prefill: the receipt draft for a purchase order — business-today
 * receipt date plus every stock line's remaining quantity, each warehouse
 * defaulted to the line's own or the entity default. Read-only: resolving a
 * default never creates a warehouse (the save stamps it through the native
 * path, or refuses naming the remedy).
 */
export const GET = defineRoute({
  permission: 'goods_receipts.create',
  feature: 'orders',
  params,
  handler: async ({ authz, params: { id } }) => {
    const gate = authz as unknown as ReceiveAuthz
    const scoped = await scopedSource(gate, id)
    if ('denied' in scoped) return scoped.denied
    try {
      const receiptDate = await businessToday(gate.user.orgId)
      const rows = (await db.execute<{
        id: string
        line_number: number
        item_id: string | null
        description: string | null
        unit: string | null
        unit_price: string
        quantity: string
        quantity_fulfilled: string
        stock_location_id: string | null
        item_kind: string | null
      }>(sql`
        select line.id, line.line_number, line.item_id, line.description, line.unit, line.unit_price,
               line.quantity, line.quantity_fulfilled, line.stock_location_id, i.kind as item_kind
          from document_lines line
          left join items i on i.id = line.item_id and i.org_id = line.org_id
         where line.org_id = ${gate.user.orgId} and line.document_id = ${id}
         order by line.line_number
      `)).rows
      const defaultWarehouse = await resolveDefaultWarehouse(db, gate.user.orgId, scoped.source.subsidiaryId)
      const lines = rows.flatMap((line) => {
        if (line.item_id == null || !lineRequiresReceipt(line.item_kind)) return []
        const remaining = toQuantityUnits(String(line.quantity)) - toQuantityUnits(String(line.quantity_fulfilled))
        if (remaining <= 0n) return []
        return [{
          sourceLineId: line.id,
          lineNumber: line.line_number,
          description: line.description,
          unit: line.unit,
          unitPrice: String(line.unit_price),
          remaining: fromQuantityUnits(remaining),
          stockLocationId: line.stock_location_id ?? defaultWarehouse,
        }]
      })
      return NextResponse.json({ receiptDate, lines })
    } catch (error) {
      if (error instanceof WarehouseRefusal) {
        return NextResponse.json(
          { error: error.message, code: error.code, details: { remedy: error.remedy } },
          { status: error.status },
        )
      }
      return unexpectedServerError('purchase-orders/receive-prefill', error)
    }
  },
})

/**
 * POST save: post the explicit receipt through the native receive path.
 * The idempotency key (header, else body) is the command's identity: a lost
 * response retried with the same key replays the stored receipt instead of
 * receiving the stock twice. A missing key refuses — the client must name
 * its command.
 */
export const POST = defineRoute({
  permission: 'goods_receipts.create',
  feature: 'orders',
  params,
  body: receiveBody,
  handler: async ({ request, authz, params: { id }, body }) => {
    const gate = authz as unknown as ReceiveAuthz
    const scoped = await scopedSource(gate, id)
    if ('denied' in scoped) return scoped.denied
    // Receiving moves stock and posts value-carrying inventory journals when
    // Inventory is enabled, so it takes items.post on top of the receiving
    // grant — the same authority the convert endpoint demands.
    if ((await isFeatureEnabled(gate.user.orgId, 'inventory')) && !can(gate, 'items.post')) {
      return NextResponse.json({ error: 'missing permission: items.post' }, { status: 403 })
    }
    const key = request.headers.get('Idempotency-Key')?.trim() || body.idempotencyKey?.trim() || ''
    if (!key) {
      return NextResponse.json(
        { error: 'Idempotency-Key header or idempotencyKey is required so a retried save never receives twice' },
        { status: 400 },
      )
    }
    try {
      const res = await receivePurchaseOrder(gate.user.orgId, gate.user.id, id, {
        receiptDate: body.receiptDate,
        idempotencyKey: key,
        lines: body.lines,
      })
      return NextResponse.json(res)
    } catch (error) {
      if (error instanceof ConversionError) return conversionResponse(error)
      if (error instanceof InventoryOwnershipError) {
        return NextResponse.json({ error: error.message }, { status: 403 })
      }
      if (error instanceof WarehouseRefusal) {
        return NextResponse.json(
          { error: error.message, code: error.code, details: { remedy: error.remedy } },
          { status: error.status },
        )
      }
      if (error instanceof InventoryError) {
        return NextResponse.json({ error: error.message }, { status: 422 })
      }
      return unexpectedServerError('purchase-orders/receive', error)
    }
  },
})
