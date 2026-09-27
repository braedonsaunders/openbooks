import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { fulfillmentDocumentScope } from '@openbooks/engine/src/sales/fulfillment.ts'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { sendShipmentTracking } from '@/lib/shipments'

/** Email the customer a completed shipment's carrier and tracking link. */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    to: z.string().email().max(320).optional(),
    message: z.string().max(2000).optional(),
  }),
  handler: async ({ authz, params: { id }, body }) => {
    const orgId = authz.user.orgId
    const shipment = await fulfillmentDocumentScope(db, orgId, id, 'shipment')
    if (!shipment || guardSubsidiaryScope(authz, shipment.subsidiaryId)) return notFound('shipment', id)
    const sent = await sendShipmentTracking(orgId, authz.user.id, {
      shipmentId: id,
      to: body.to,
      message: body.message,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return NextResponse.json(sent)
  },
})
