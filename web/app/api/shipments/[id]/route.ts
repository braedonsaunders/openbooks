import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  fulfillmentDocumentScope,
  getFulfillmentDocument,
  setShipmentCarrier,
  setShipmentCartons,
} from '@openbooks/engine/src/sales/fulfillment.ts'
import { uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { saveFulfillmentCustom } from '@/lib/shipments'

const params = z.object({ id: z.string().uuid() })

/** One shipment with its lines, carrier and tracking link. */
export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params,
  handler: async ({ authz, params: { id } }) => {
    const shipment = await getFulfillmentDocument(db, authz.user.orgId, id, authz.allowedSubsidiaryIds)
    if (!shipment || shipment.kind !== 'shipment') return notFound('shipment', id)
    return NextResponse.json({ shipment })
  },
})

const updateBody = z.object({
  carrier: z.object({
    carrierId: uuidId,
    service: z.string().max(100),
    trackingNumber: z.string().max(100).nullable().optional(),
  }).optional(),
  cartons: z.array(z.object({
    lineId: uuidId,
    carton: z.string().max(60).nullable(),
  })).max(500).optional(),
  /** Header custom-field values; validated against the record type's definitions. */
  custom: z.record(z.string(), z.json()).optional(),
}).refine((body) => body.carrier !== undefined || body.cartons !== undefined || body.custom !== undefined, {
  message: 'send a carrier, cartons or custom fields to change',
})

/** Change a draft shipment's carrier, service, tracking number, cartons or custom fields. */
export const PATCH = defineRoute({
  permission: 'orders.fulfill',
  feature: 'fulfillment',
  params,
  body: updateBody,
  handler: async ({ authz, params: { id }, body }) => {
    const orgId = authz.user.orgId
    const scope = await fulfillmentDocumentScope(db, orgId, id, 'shipment')
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound('shipment', id)
    const allowedSubsidiaryIds = authz.allowedSubsidiaryIds
    await db.transaction(async (tx) => {
      if (body.carrier) {
        await setShipmentCarrier(tx, orgId, authz.user.id, { shipmentId: id, ...body.carrier, allowedSubsidiaryIds })
      }
      if (body.cartons) {
        await setShipmentCartons(tx, orgId, authz.user.id, { shipmentId: id, cartons: body.cartons, allowedSubsidiaryIds })
      }
      if (body.custom) {
        await saveFulfillmentCustom(tx, orgId, authz.user.id, { documentId: id, kind: 'shipment', custom: body.custom })
      }
    })
    const shipment = await getFulfillmentDocument(db, orgId, id, allowedSubsidiaryIds)
    return NextResponse.json({ shipment })
  },
})
