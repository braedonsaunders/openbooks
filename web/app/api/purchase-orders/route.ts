import { orderCreateBody } from '@/lib/api/json'
import { defineRoute } from '@/lib/api/route'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { createOrder } from '../_order/create'

export const runtime = 'nodejs'

/**
 * Unsaved-create collection: the purchase-order drawer opens and cancels
 * with zero writes; its explicit Save persists here exactly once
 * (idempotent, audited, status=draft). The body parses through the typed
 * order-create boundary before the kernel sees it.
 */
export const POST = defineRoute({
  authorize: () => guardFeaturePermission('ap.create', 'orders'),
  feature: { none: 'The purchase-order create guard combines ap.create with the orders feature.' },
  body: orderCreateBody,
  handler: async ({ request, authz, body }) =>
    createOrder({ kind: 'purchase_order', createPerm: 'ap.create', numberPrefix: 'PO-' }, authz, request, body),
})
