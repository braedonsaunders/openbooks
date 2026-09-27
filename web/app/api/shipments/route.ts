import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { createShipment, fulfillmentDocumentScope } from '@openbooks/engine/src/sales/fulfillment.ts'
import { isoDate, uuidId } from '@/lib/api/json'
import { created, notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'

const createBody = z.object({
  pickListId: uuidId,
  documentDate: isoDate().optional(),
  memo: z.string().max(2000).nullable().optional(),
  /** Omit to ship every pick line in full. */
  lines: z.array(z.object({
    pickLineId: uuidId,
    quantity: z.string().max(40),
    carton: z.string().max(60).nullable().optional(),
  })).min(1).max(500).optional(),
})

/** Create a draft shipment from a released pick list. */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  body: createBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const pickList = await fulfillmentDocumentScope(db, orgId, body.pickListId, 'pick_list')
    // Out of scope answers exactly like an absent pick list.
    if (!pickList || guardSubsidiaryScope(authz, pickList.subsidiaryId)) return notFound('pick_list', body.pickListId)
    const shipment = await db.transaction((tx) =>
      createShipment(tx, orgId, authz.user.id, { ...body, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }),
    )
    return created({ shipment })
  },
})
