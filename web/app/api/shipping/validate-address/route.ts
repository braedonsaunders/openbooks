import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { validateShipmentAddress } from '@openbooks/engine/sales/shipping-labels'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { fulfillmentDocumentScope } from '@openbooks/engine/sales/fulfillment'
import { guardSubsidiaryScope } from '@/lib/authz'

const validateBody = z.object({
  shipmentId: z.string().uuid(),
  accountId: z.string().uuid().nullable().optional(),
})

/**
 * Check the ship-to address against the provider. Suggestions are returned,
 * never applied — the operator keeps the address they entered.
 */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'shippingHub',
  body: validateBody,
  handler: async ({ authz, body }) => {
    const scope = await fulfillmentDocumentScope(db, authz.user.orgId, body.shipmentId, 'shipment')
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound('shipment', body.shipmentId)
    const answer = await db.transaction((tx) =>
      validateShipmentAddress(tx, authz.user.orgId, {
        shipmentId: body.shipmentId,
        accountId: body.accountId,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    )
    return NextResponse.json({ validation: answer })
  },
})
