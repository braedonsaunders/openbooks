import { makeGET, makePATCH } from '../../_order/handlers'

export const runtime = 'nodejs'

const cfg = { kind: 'purchase_order', readPerm: 'ap.read', createPerm: 'ap.create' } as const

export const GET = makeGET(cfg)
export const PATCH = makePATCH(cfg)
