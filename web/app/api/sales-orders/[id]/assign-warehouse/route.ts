import { makeAssignWarehousePOST } from '../../../_order/handlers'

export const runtime = 'nodejs'

const cfg = { kind: 'sales_order', readPerm: 'ar.read', createPerm: 'ar.create' } as const

export const POST = makeAssignWarehousePOST(cfg)
