import { NextResponse } from 'next/server'
import { z } from 'zod'
import { bulkEditVariants } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@/lib/list-params'

const familyParams = z.object({ id: z.string() })

const bulkEditSchema = z.object({
  variantIds: z.array(z.string()).min(1),
  price: z.string().nullable().optional(),
  cost: z.string().nullable().optional(),
  barcode: z.object({ value: z.string(), kind: z.enum(['gtin', 'upc', 'ean', 'internal']) }).nullable().optional(),
  isActive: z.boolean().nullable().optional(),
}).strict()

/** Set price, cost, barcode or status across selected variants in one audited transaction. */
export const POST = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: familyParams,
  body: bulkEditSchema,
  handler: async ({ params: { id }, body, authz: gate }) => {
    if (!isUuid(id)) return notFound('record')
    for (const variantId of body.variantIds) {
      if (!isUuid(variantId)) return notFound('record')
    }
    const result = await bulkEditVariants(gate.user.orgId, gate.user.id, {
      variantIds: body.variantIds,
      price: body.price,
      cost: body.cost,
      barcode: body.barcode ?? undefined,
      isActive: body.isActive,
    })
    if (result.familyId !== id) return notFound('record')
    return NextResponse.json(result)
  },
})
