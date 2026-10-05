import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { voidShipmentLabel } from '@openbooks/engine/sales/shipping-labels'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

const labelParams = z.object({ id: z.string().uuid() })

const voidBody = z.object({ reason: z.string().min(5).max(500) })

/** Void a purchased label: the provider refund is requested, then the cost reverses. */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  params: labelParams,
  body: voidBody,
  handler: async ({ authz, params: { id }, body }) => {
    const voided = await db.transaction((tx) =>
      voidShipmentLabel(tx, authz.user.orgId, authz.user.id, {
        labelId: id,
        reason: body.reason,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    ).catch((error: unknown) => {
      if (error instanceof Error && (error as { code?: unknown }).code === 'not_found') return null
      throw error
    })
    if (!voided) return notFound('label', id)
    return NextResponse.json({ voided })
  },
})
