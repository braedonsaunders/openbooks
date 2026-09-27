import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { NextResponse } from 'next/server'
import { makeConvertPOST } from '../../../_order/handlers'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { conversionWouldCopyInventoryKinds } from '../../../../../lib/order-cycle'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const convert = makeConvertPOST({ kind: 'sales_order', readPerm: 'ar.read', createPerm: 'ar.create' })

export const POST = defineRoute({
  permission: 'ar.create',
  feature: 'orders',
  params: z.object({ "id": z.string() }),
  handler: async ({ request: req, authz: gate, params: routeParams }) => {
    const ctx = { params: Promise.resolve(routeParams) };
    const { id } = await ctx.params
    // A malformed id names no uuid document: refuse it before the
    // inventory-kind probe binds it to a uuid column (raw 500 when
    // Inventory is off), the same 404 the convert handler answers.
    if (!isUuid(id)) return notFound("record")
    if (await conversionWouldCopyInventoryKinds(gate.user.orgId, id)) {
      return notFound("record")
    }
    return convert(req, ctx)

  },
})
