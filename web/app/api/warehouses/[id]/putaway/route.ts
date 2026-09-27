import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { executeIdempotentInventoryAction } from '@openbooks/engine/src/inventory/action-idempotency.ts'
import { putAwayStagedStock } from '@openbooks/engine/src/inventory/putaway.ts'
import { getWarehouse } from '@openbooks/engine/src/inventory/warehouses.ts'
import { exactMoney, isoDate, uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'

/**
 * Directed putaway: move staged stock of one legal entity to the location the
 * warehouse's putaway rules resolve. It moves stock, so it needs the posting
 * grant, answers 404 for an entity outside the caller's scope, and runs
 * through the inventory idempotency boundary so a retried request replays
 * instead of moving the stock twice.
 */
export const POST = defineRoute({
  permission: 'items.post',
  feature: 'warehousing',
  params: z.object({ id: uuidId }),
  body: z.object({
    stagingLocationId: uuidId,
    itemId: uuidId,
    subsidiaryId: uuidId,
    quantity: exactMoney(),
    idempotencyKey: z.string().min(8).max(200),
    /** The business date the client froze when it offered the action, so a
     *  retry after midnight replays instead of conflicting. */
    date: isoDate().optional(),
  }),
  handler: async ({ authz, params: { id }, body }) => {
    const orgId = authz.user.orgId
    const denied = guardSubsidiaryScope(authz, body.subsidiaryId)
    if (denied) return denied
    if (!(await getWarehouse(db, orgId, id))) return notFound('warehouse', id)
    const date = body.date ?? await businessToday(orgId)
    const request = {
      warehouseId: id,
      stagingLocationId: body.stagingLocationId,
      itemId: body.itemId,
      subsidiaryId: body.subsidiaryId,
      quantity: body.quantity,
      date,
    }
    const outcome = await executeIdempotentInventoryAction(orgId, authz.user.id, {
      operation: 'warehouse.putaway',
      idempotencyKey: body.idempotencyKey,
      request,
      execute: () => db.transaction((tx) => putAwayStagedStock(tx, orgId, authz.user.id, request)),
    })
    return NextResponse.json({ ...outcome.value, replayed: outcome.replayed })
  },
})
