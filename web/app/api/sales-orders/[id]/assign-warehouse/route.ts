import { makeAssignWarehousePOST } from '../../../_order/handlers'
import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'

export const runtime = 'nodejs'

const cfg = { kind: 'sales_order', readPerm: 'ar.read', createPerm: 'ar.create' } as const

const assignWarehouse = makeAssignWarehousePOST(cfg)

export const POST = defineRoute({
  permission: 'ar.create',
  feature: 'orders',
  params: z.object({ id: z.string() }),
  handler: ({ request, params }) => assignWarehouse(request, { params: Promise.resolve(params) }),
})
