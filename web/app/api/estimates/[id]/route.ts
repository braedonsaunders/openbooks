import { makeGET, makePATCH, makeDELETE } from '../../_order/handlers'
import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'

export const runtime = 'nodejs'

const cfg = { kind: 'quote', readPerm: 'estimates.read', createPerm: 'estimates.create' } as const

const get = makeGET(cfg)
const patch = makePATCH(cfg)
const remove = makeDELETE(cfg)
const params = z.object({ id: z.string() })

export const GET = defineRoute({
  permission: 'estimates.read',
  feature: 'orders',
  params,
  handler: ({ request, params }) => get(request, { params: Promise.resolve(params) }),
})
export const PATCH = defineRoute({
  permission: 'estimates.create',
  feature: 'orders',
  params,
  handler: ({ request, params }) => patch(request, { params: Promise.resolve(params) }),
})
export const DELETE = defineRoute({
  permission: 'estimates.create',
  feature: 'orders',
  params,
  handler: ({ request, params }) => remove(request, { params: Promise.resolve(params) }),
})
