import { NextResponse } from 'next/server'
import { makeConvertPOST } from '../../../_order/handlers'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { conversionWouldCopyInventoryKinds } from '../../../../../lib/order-cycle'

export const runtime = 'nodejs'

const convert = makeConvertPOST({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('ar.create', 'orders')
  if (gate instanceof NextResponse) return gate
  const { id } = await ctx.params
  if (await conversionWouldCopyInventoryKinds(gate.user.orgId, id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return convert(req, ctx)
}
