import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { fulfillmentDocumentScope } from '@openbooks/engine/src/sales/fulfillment.ts'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { assertCan, guardSubsidiaryScope } from '@/lib/authz'
import { completeShipment } from '@/lib/shipments'

/**
 * Complete a shipment: record its sales fulfilment from the picked bins and
 * end the pick list's reservation. It moves stock, so it also needs the
 * posting grant. A retry answers with the fulfilment already recorded.
 */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ authz, params: { id } }) => {
    assertCan(authz, 'items.post')
    const orgId = authz.user.orgId
    const scope = await fulfillmentDocumentScope(db, orgId, id, 'shipment')
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound('shipment', id)
    const completed = await completeShipment(orgId, authz.user.id, {
      shipmentId: id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return NextResponse.json(completed)
  },
})
