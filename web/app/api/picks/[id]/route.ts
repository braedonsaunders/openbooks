import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { getFulfillmentDocument } from '@openbooks/engine/src/sales/fulfillment.ts'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

/** One pick list with its lines; out of scope answers like an absent one. */
export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ authz, params: { id } }) => {
    const pickList = await getFulfillmentDocument(db, authz.user.orgId, id, authz.allowedSubsidiaryIds)
    if (!pickList || pickList.kind !== 'pick_list') return notFound('pick_list', id)
    return NextResponse.json({ pickList })
  },
})
