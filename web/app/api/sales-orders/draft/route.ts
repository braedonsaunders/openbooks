import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { createOrderDraft } from '../../../../lib/order-cycle'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft sales order and return its id. */
export async function POST() {
  const gate = await guardFeaturePermission('ar.create', 'orders')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const doc = await createOrderDraft(user.orgId, user.id, 'sales_order')
  return NextResponse.json(doc)
}
