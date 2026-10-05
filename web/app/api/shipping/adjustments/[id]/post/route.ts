import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { postBillingAdjustment } from '@openbooks/engine/sales/shipping-labels'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

const postParams = z.object({ id: z.string().uuid() })

/** Post one pending billing adjustment against its label. */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  params: postParams,
  handler: async ({ authz, params: { id } }) => {
    const posted = await db.transaction((tx) =>
      postBillingAdjustment(tx, authz.user.orgId, authz.user.id, id),
    ).catch((error: unknown) => {
      if (error instanceof Error && (error as { code?: unknown }).code === 'not_found') return null
      throw error
    })
    if (!posted) return notFound('adjustment', id)
    return NextResponse.json({ posted })
  },
})
