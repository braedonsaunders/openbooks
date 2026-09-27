import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  backorderPosition,
  cancelOrderLineRemainder,
  salesOrderScope,
} from '@openbooks/engine/src/sales/backorders.ts'
import { guardSubsidiaryScope } from '@/lib/authz'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'

const params = z.object({ id: z.string().uuid() })

/** The quantity travels as decimal text so it never crosses a float; the
 *  engine classifies an unreadable value and names the remedy. */
const cancelBody = z.object({
  lineId: z.string().uuid(),
  quantity: z.string().max(40),
  reason: z.string().max(1000),
})

/** The order's backorder position: its stock lines with open quantity. */
export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params,
  handler: async ({ authz, params: { id } }) => {
    const orgId = authz.user.orgId
    const order = await salesOrderScope(db, orgId, id)
    if (!order) return notFound('sales_order', id)
    // Out of scope answers exactly like an absent order.
    if (guardSubsidiaryScope(authz, order.subsidiaryId)) return notFound('sales_order', id)
    const lines = await backorderPosition(db, orgId, {
      documentId: order.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return NextResponse.json({ lines })
  },
})

/** Cancel part of a line's open quantity, with a reason. */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params,
  body: cancelBody,
  handler: async ({ authz, params: { id }, body }) => {
    const orgId = authz.user.orgId
    const order = await salesOrderScope(db, orgId, id)
    if (!order) return notFound('sales_order', id)
    // Out of scope answers exactly like an absent order.
    if (guardSubsidiaryScope(authz, order.subsidiaryId)) return notFound('sales_order', id)
    const result = await db.transaction((tx) =>
      cancelOrderLineRemainder(tx, orgId, authz.user.id, {
        documentId: order.id,
        lineId: body.lineId,
        quantity: body.quantity,
        reason: body.reason,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    )
    return NextResponse.json(result)
  },
})
