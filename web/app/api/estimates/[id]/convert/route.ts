import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import 'next/server';
import { makeConvertPOST } from '../../../_order/handlers'
import '../../../../../lib/feature-gates';
import { isUuid } from '../../../../../lib/list-params'
import { conversionWouldCopyInventoryKinds } from '../../../../../lib/order-cycle'
import { estimateConversionPermission } from '../../../../../lib/permissions'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

// Converting mints the downstream document under its own book's authority:
// a sales order or invoice still needs ar.create, so pricing estimates can
// never mint receivables on its own (estimateConversionPermission).
const convert = makeConvertPOST({ kind: 'quote', readPerm: 'estimates.read', createPerm: 'estimates.create', convertPerm: estimateConversionPermission })

export const POST = defineRoute({
  permission: 'estimates.create',
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
