import { makeConvertPOST } from '../../../_order/handlers'

export const runtime = 'nodejs'

export const POST = makeConvertPOST({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })
