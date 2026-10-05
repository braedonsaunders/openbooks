import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { refreshLabelTracking } from '@openbooks/engine/sales/shipping-labels'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

const labelParams = z.object({ id: z.string().uuid() })

/** Re-read one label's tracker over the sealed API key and store what moved. */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'shippingHub',
  params: labelParams,
  handler: async ({ authz, params: { id } }) => {
    const refreshed = await db.transaction((tx) =>
      refreshLabelTracking(tx, authz.user.orgId, authz.user.id, { labelId: id }),
    ).catch((error: unknown) => {
      if (error instanceof Error && (error as { code?: unknown }).code === 'not_found') return null
      throw error
    })
    if (!refreshed) return notFound('label', id)
    return NextResponse.json({ refreshed })
  },
})
