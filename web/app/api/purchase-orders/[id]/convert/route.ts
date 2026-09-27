import { NextResponse } from 'next/server'
import { makeConvertPOST } from '../../../_order/handlers'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { conversionWouldCopyInventoryKinds } from '../../../../../lib/order-cycle'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const convert = makeConvertPOST({ kind: 'purchase_order', readPerm: 'ap.read', createPerm: 'ap.create' })

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('ap.create', 'orders')
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
