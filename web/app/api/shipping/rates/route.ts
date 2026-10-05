import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { getShipmentRates } from '@openbooks/engine/src/sales/shipping-labels.ts'
import { defineRoute } from '@/lib/api/route'

const ratesBody = z.object({
  shipmentId: z.string().uuid(),
  accountId: z.string().uuid().nullable().optional(),
  presetId: z.string().uuid().nullable().optional(),
  direction: z.enum(['outbound', 'return']).optional(),
})

/**
 * Ranked live carrier rates for a draft shipment. Rating never spends
 * money, so it rides the fulfil-orders grant; buying is the spendy step
 * and carries its own grant on the labels route.
 */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'shippingHub',
  body: ratesBody,
  handler: async ({ authz, body }) => {
    const quote = await db.transaction((tx) =>
      getShipmentRates(tx, authz.user.orgId, authz.user.id, {
        shipmentId: body.shipmentId,
        accountId: body.accountId,
        presetId: body.presetId,
        direction: body.direction,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    )
    return NextResponse.json({ quote })
  },
})
