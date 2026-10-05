import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { buyShipmentLabel, getShipmentLabels } from '@openbooks/engine/sales/shipping-labels'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { fulfillmentDocumentScope } from '@openbooks/engine/sales/fulfillment'
import { guardSubsidiaryScope } from '@/lib/authz'

/** Every bought label on one shipment, newest first, for the drawer timeline. */
export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'shippingHub',
  handler: async ({ authz, request }) => {
    const shipmentId = new URL(request.url).searchParams.get('shipmentId')
    if (!shipmentId) return NextResponse.json({ error: 'shipmentId is required' }, { status: 400 })
    const scope = await fulfillmentDocumentScope(db, authz.user.orgId, shipmentId, 'shipment')
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound('shipment', shipmentId)
    const labels = await getShipmentLabels(db, authz.user.orgId, shipmentId)
    return NextResponse.json({ labels })
  },
})

const buyBody = z.object({
  shipmentId: z.string().uuid(),
  providerRateId: z.string().min(1).max(200),
  accountId: z.string().uuid().nullable().optional(),
  direction: z.enum(['outbound', 'return']).optional(),
})

/**
 * Buy a quoted label: idempotent per shipment and rate, costed to the
 * shipping expense account against the carrier payable. Buying spends
 * real carrier money, so it carries the shipping grant, not just fulfil.
 */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  body: buyBody,
  handler: async ({ authz, body }) => {
    const scope = await fulfillmentDocumentScope(db, authz.user.orgId, body.shipmentId, 'shipment')
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound('shipment', body.shipmentId)
    const bought = await db.transaction((tx) =>
      buyShipmentLabel(tx, authz.user.orgId, authz.user.id, {
        shipmentId: body.shipmentId,
        providerRateId: body.providerRateId,
        accountId: body.accountId,
        direction: body.direction,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    )
    // BigInts never reach JSON: the amount travels as a minor-units string.
    return NextResponse.json({ label: { ...bought, amountMinor: bought.amountMinor.toString() } })
  },
})
