import { NextResponse } from 'next/server'
import { orderCreateBody, parseJsonBody } from '@/lib/api/json'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { createOrder } from '../_order/create'

export const runtime = 'nodejs'

/**
 * Unsaved-create collection: the purchase-order drawer opens and cancels
 * with zero writes; its explicit Save persists here exactly once
 * (idempotent, audited, status=draft). The body parses through the typed
 * order-create boundary before the kernel sees it.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('ap.create', 'orders')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, orderCreateBody)
  if (!parsed.ok) return parsed.response
  return createOrder({ kind: 'purchase_order', createPerm: 'ap.create', numberPrefix: 'PO-' }, gate, req, parsed.data)
}
