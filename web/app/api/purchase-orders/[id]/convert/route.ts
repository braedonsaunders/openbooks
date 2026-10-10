import { NextResponse } from 'next/server'
import { makeConvertPOST } from '../../../_order/handlers'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { conversionWouldCopyInventoryKinds } from '../../../../../lib/order-cycle'
import { notFound } from "@/lib/api/responses";
import { PURCHASE_ORDER_PERMISSIONS, purchaseOrderConversionPermission } from '@/lib/permissions'
import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'


export const runtime = 'nodejs'

// Reading the order opens the endpoint; the conversion target decides the
// rest: receiving goods needs goods_receipts.create, billing needs ap.create.
const convert = makeConvertPOST({
  kind: 'purchase_order',
  readPerm: PURCHASE_ORDER_PERMISSIONS.read,
  createPerm: PURCHASE_ORDER_PERMISSIONS.create,
  convertPerm: purchaseOrderConversionPermission,
})

async function convertPurchaseOrder(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission(PURCHASE_ORDER_PERMISSIONS.read, 'orders')
  if (gate instanceof NextResponse) return gate
  const { id } = await ctx.params
  // A malformed id names no uuid document: refuse it before the
  // inventory-kind probe binds it to a uuid column (raw 500 when
  // Inventory is off), the same 404 the convert handler answers.
  if (!isUuid(id)) return notFound("record")
  if (await conversionWouldCopyInventoryKinds(gate.user.orgId, id)) {
    return notFound("record")
  }
  return convert(req, ctx)
}

export const POST = defineRoute({
  authorize: () => guardFeaturePermission(PURCHASE_ORDER_PERMISSIONS.read, 'orders'),
  feature: { none: 'Purchase-order conversion is guarded by purchase_orders.read and the orders feature before dispatch; the target kind decides its own grant.' },
  params: z.object({ id: z.string() }),
  handler: async ({ request, params }) => convertPurchaseOrder(request, { params: Promise.resolve(params) }),
})
