import { makeGET, makePATCH } from '../../_order/handlers'

export const runtime = 'nodejs'

const cfg = { kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' } as const

export const GET = makeGET(cfg)
export const PATCH = makePATCH(cfg)
