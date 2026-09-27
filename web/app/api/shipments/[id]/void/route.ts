import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { fulfillmentDocumentScope, voidShipment } from '@openbooks/engine/src/sales/fulfillment.ts'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'

/** Void a draft shipment, with a reason; its pick list keeps holding the bins. */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(1000) }),
  handler: async ({ authz, params: { id }, body }) => {
    const orgId = authz.user.orgId
    const shipment = await fulfillmentDocumentScope(db, orgId, id, 'shipment')
    if (!shipment || guardSubsidiaryScope(authz, shipment.subsidiaryId)) return notFound('shipment', id)
    await db.transaction((tx) =>
      voidShipment(tx, orgId, authz.user.id, {
        shipmentId: id,
        reason: body.reason,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    )
    return NextResponse.json({ id, status: 'voided' })
  },
})
