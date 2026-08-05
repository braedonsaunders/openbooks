import { makeConvertPOST } from '../../../_order/handlers'

export const runtime = 'nodejs'

export const POST = makeConvertPOST({ kind: 'purchase_order', readPerm: 'ap.read', createPerm: 'ap.create' })
