import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { createOrderDraft, OrderDraftError } from '../../../../lib/order-cycle'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft sales order and return its id. */
export async function POST() {
  const gate = await guardFeaturePermission('ar.create', 'orders')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  try {
    const doc = await createOrderDraft(user.orgId, user.id, 'sales_order')
    return NextResponse.json(doc)
  } catch (error) {
    if (error instanceof OrderDraftError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
