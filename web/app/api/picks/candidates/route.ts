import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { salesOrderScope } from '@openbooks/engine/src/sales/backorders.ts'
import { pickCandidates } from '@openbooks/engine/src/sales/fulfillment.ts'
import { guardSubsidiaryScope } from '@/lib/authz'
import { defineRoute } from '@/lib/api/route'
import { notFound, unprocessable } from '@/lib/api/responses'

const query = z.object({ salesOrderId: z.string().uuid() })

/**
 * What an issued sales order still has to pick: each open stock line with
 * its open quantity, what active pick lists already hold, the pickable
 * remainder, and the bins that carry the item. The create-pick-list form
 * starts from this; release re-checks every bin under the position locks.
 */
export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  handler: async ({ request, authz }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) {
      return unprocessable('Name the sales order to pick with ?salesOrderId=<id>', {
        field: 'salesOrderId',
        status: 400,
      })
    }
    const { salesOrderId } = parsed.data
    const orgId = authz.user.orgId
    const order = await salesOrderScope(db, orgId, salesOrderId)
    if (!order) return notFound('sales_order', salesOrderId)
    // Out of scope answers exactly like an absent order.
    if (guardSubsidiaryScope(authz, order.subsidiaryId)) return notFound('sales_order', salesOrderId)
    const candidates = await pickCandidates(db, orgId, order.id, authz.allowedSubsidiaryIds)
    if (!candidates) return notFound('sales_order', salesOrderId)
    return NextResponse.json(candidates)
  },
})
