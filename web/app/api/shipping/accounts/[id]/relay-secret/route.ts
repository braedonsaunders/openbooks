import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { rotateShippingRelaySecret } from '@openbooks/engine/sales/shipping-labels'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

const accountParams = z.object({ id: z.string().uuid() })

/**
 * Issue or rotate the relay secret tracker deliveries must be signed with.
 * The new secret is answered exactly once; only its sealed form is stored.
 */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  params: accountParams,
  handler: async ({ authz, params: { id } }) => {
    const rotated = await db.transaction((tx) =>
      rotateShippingRelaySecret(tx, authz.user.orgId, authz.user.id, id),
    ).catch((error: unknown) => {
      if (error instanceof Error && (error as { code?: unknown }).code === 'not_found') return null
      throw error
    })
    if (!rotated) return notFound('account', id)
    return NextResponse.json({ connected: rotated })
  },
})
