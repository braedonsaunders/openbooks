import { makeAssignWarehousePOST } from '../../../_order/handlers'
import { defineRoute } from '@/lib/api/route'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { z } from 'zod'

export const runtime = 'nodejs'

const cfg = { kind: 'purchase_order', readPerm: 'purchase_orders.read', createPerm: 'purchase_orders.create' } as const

const assignWarehouse = makeAssignWarehousePOST(cfg)
export const POST = defineRoute({
  authorize: () => guardFeaturePermission(cfg.createPerm, 'orders'),
  feature: { none: 'Warehouse assignment is guarded by purchase_orders.create and the orders feature in the shared order handler.' },
  params: z.object({ id: z.string() }),
  handler: async ({ request, params }) => assignWarehouse(request, { params: Promise.resolve(params) }),
})
