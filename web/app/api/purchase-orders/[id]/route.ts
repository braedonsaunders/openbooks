import { makeGET, makePATCH, makeDELETE } from '../../_order/handlers'
import { defineRoute } from '@/lib/api/route'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { z } from 'zod'

export const runtime = 'nodejs'

const cfg = { kind: 'purchase_order', readPerm: 'ap.read', createPerm: 'ap.create' } as const

const getOrder = makeGET(cfg)
const patchOrder = makePATCH(cfg)
const deleteOrder = makeDELETE(cfg)
const orderParams = z.object({ id: z.string() })

export const GET = defineRoute({
  authorize: () => guardFeaturePermission(cfg.readPerm, 'orders'),
  feature: { none: 'The shared order handler combines its read permission with the orders feature.' },
  params: orderParams,
  handler: async ({ request, params }) => getOrder(request, { params: Promise.resolve(params) }),
})
export const PATCH = defineRoute({
  authorize: () => guardFeaturePermission(cfg.createPerm, 'orders'),
  feature: { none: 'The shared order handler combines its edit permission with the orders feature.' },
  params: orderParams,
  handler: async ({ request, params }) => patchOrder(request, { params: Promise.resolve(params) }),
})
export const DELETE = defineRoute({
  authorize: () => guardFeaturePermission(cfg.createPerm, 'orders'),
  feature: { none: 'The shared order handler combines its delete permission with the orders feature.' },
  params: orderParams,
  handler: async ({ request, params }) => deleteOrder(request, { params: Promise.resolve(params) }),
})
