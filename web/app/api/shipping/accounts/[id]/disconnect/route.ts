import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { disconnectShippingAccount } from '@openbooks/engine/src/sales/shipping-labels.ts'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

const accountParams = z.object({ id: z.string().uuid() })

/** Park an account without deleting its labels, quotes, or cost history. */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  params: accountParams,
  handler: async ({ authz, params: { id } }) => {
    const disconnected = await db.transaction((tx) =>
      disconnectShippingAccount(tx, authz.user.orgId, authz.user.id, id).then(() => true),
    ).catch((error: unknown) => {
      if (error instanceof Error && (error as { code?: unknown }).code === 'not_found') return false
      throw error
    })
    if (!disconnected) return notFound('account', id)
    return NextResponse.json({ disconnected: true })
  },
})
