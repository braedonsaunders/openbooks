import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { createOrderDraft } from '../../../../lib/order-cycle'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft sales order and return its id. */
export async function POST() {
  const gate = await guardPermission('ar.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const doc = await createOrderDraft(user.orgId, user.id, 'sales_order')
  return NextResponse.json(doc)
}
