import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { importBillingAdjustments } from '@openbooks/engine/sales/shipping-labels'
import { defineRoute } from '@/lib/api/route'

const adjustmentItem = z.object({
  providerAdjustmentId: z.string().min(1).max(200),
  providerShipmentId: z.string().min(1).max(200),
  kind: z.enum(['weight_correction', 'dimension_correction', 'address_correction', 'fuel', 'duplicate', 'other']),
  amount: z.string().min(1).max(40),
  currency: z.string().length(3),
  reason: z.string().max(500).nullable().optional(),
  occurredAt: z.string().max(30).nullable().optional(),
})

const importBody = z.object({
  accountId: z.string().uuid(),
  items: z.array(adjustmentItem).min(1).max(500),
})

/**
 * Import carrier billing adjustments against their labels. Replaying a
 * billing file converges on provider identity instead of double-booking.
 */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  body: importBody,
  handler: async ({ authz, body }) => {
    const result = await db.transaction((tx) =>
      importBillingAdjustments(tx, authz.user.orgId, authz.user.id, body.accountId, body.items),
    )
    return NextResponse.json({ adjustments: result })
  },
})

