import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { salesOrderScope } from '@openbooks/engine/src/sales/backorders.ts'
import { createPickList } from '@openbooks/engine/src/sales/fulfillment.ts'
import { isoDate, uuidId } from '@/lib/api/json'
import { created, notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'

/** Quantities travel as decimal text so they never cross a float; the
 *  engine classifies an unreadable value and names the remedy. */
const createBody = z.object({
  salesOrderId: uuidId,
  documentDate: isoDate().optional(),
  memo: z.string().max(2000).nullable().optional(),
  lines: z.array(z.object({
    salesOrderLineId: uuidId,
    binId: uuidId,
    quantity: z.string().max(40),
    lotId: uuidId.nullable().optional(),
    serialId: uuidId.nullable().optional(),
  })).min(1).max(500),
})

/** Create a draft pick list reserving bin stock for an issued sales order. */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  body: createBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const order = await salesOrderScope(db, orgId, body.salesOrderId)
    if (!order) return notFound('sales_order', body.salesOrderId)
    // Out of scope answers exactly like an absent order.
    if (guardSubsidiaryScope(authz, order.subsidiaryId)) return notFound('sales_order', body.salesOrderId)
    const pickList = await db.transaction((tx) =>
      createPickList(tx, orgId, authz.user.id, { ...body, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }),
    )
    return created({ pickList })
  },
})
