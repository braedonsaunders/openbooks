import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { testShippingConnection } from '@openbooks/engine/sales/shipping-labels'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

const accountParams = z.object({ id: z.string().uuid() })

/** Test the connection end to end over the sealed key. */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  params: accountParams,
  handler: async ({ authz, params: { id } }) => {
    const result = await db.transaction((tx) =>
      testShippingConnection(tx, authz.user.orgId, authz.user.id, id),
    ).catch((error: unknown) => {
      if (error instanceof Error && (error as { code?: unknown }).code === 'not_found') return null
      throw error
    })
    if (!result) return notFound('account', id)
    return NextResponse.json({ test: result })
  },
})
