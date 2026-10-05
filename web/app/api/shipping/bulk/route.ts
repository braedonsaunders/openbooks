import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import {
  getShipmentRates,
  listBulkCandidates,
  selectRateByRule,
  ShippingRefusal,
} from '@openbooks/engine/sales/shipping-labels'
import { defineRoute } from '@/lib/api/route'

/** Draft, open shipments without a purchased label, for the bulk buyer. */
export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'shippingHub',
  handler: async ({ authz }) => {
    const candidates = await listBulkCandidates(db, authz.user.orgId, authz.allowedSubsidiaryIds)
    return NextResponse.json({ candidates })
  },
})

const bulkBody = z.object({
  shipmentIds: z.array(z.string().uuid()).min(1).max(100),
  accountId: z.string().uuid().nullable().optional(),
  rule: z.enum(['cheapest', 'fastest', 'cheapest_by_date']).default('cheapest'),
  promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

type PreviewRow =
  | {
    shipmentId: string
    documentNumber: string
    ok: true
    providerRateId: string
    carrier: string
    service: string
    amount: string
    currency: string
    deliveryDate: string | null
  }
  | {
    shipmentId: string
    documentNumber: string | null
    ok: false
    code: string
    message: string
    remedy?: string
  }

/**
 * Preview bulk buying: one rate per shipment under the buying rule, the
 * total per currency, and every shipment that cannot be rated with its
 * reason — so the operator fixes data in place instead of buying blind.
 */
export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'shippingHub',
  body: bulkBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const rows: PreviewRow[] = []
    for (const shipmentId of body.shipmentIds) {
      try {
        const quote = await db.transaction((tx) =>
          getShipmentRates(tx, orgId, authz.user.id, {
            shipmentId,
            accountId: body.accountId,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          }),
        )
        const chosen = selectRateByRule(quote.rates, body.rule, body.promisedDate)
        if (!chosen) {
          rows.push({
            shipmentId,
            documentNumber: quote.documentNumber,
            ok: false,
            code: 'no_rate_on_time',
            message: `No rate for ${quote.documentNumber} arrives by ${body.promisedDate}`,
            remedy: 'Pick a later promised date or buy the fastest rate instead',
          })
          continue
        }
        rows.push({
          shipmentId,
          documentNumber: quote.documentNumber,
          ok: true,
          providerRateId: chosen.providerRateId,
          carrier: chosen.carrier,
          service: chosen.service,
          amount: chosen.amount,
          currency: chosen.currency,
          deliveryDate: chosen.deliveryDate,
        })
      } catch (error) {
        rows.push({
          shipmentId,
          documentNumber: null,
          ok: false,
          code: error instanceof ShippingRefusal ? error.code : 'failed',
          message: error instanceof Error ? error.message : 'Rating failed',
          remedy: error instanceof ShippingRefusal ? error.remedy : undefined,
        })
      }
    }
    return NextResponse.json({ rows })
  },
})
