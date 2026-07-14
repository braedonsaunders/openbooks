import { NextResponse } from 'next/server'
import { createPaymentDocument } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../lib/authz'
import { isPaymentKind, paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft payment/receipt, return its id. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { kind?: string }
  if (!isPaymentKind(body.kind)) {
    return NextResponse.json({ error: 'kind must be vendor_payment or customer_payment' }, { status: 400 })
  }
  const gate = await guardPermission(paymentPermission(body.kind))
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  try {
    const doc = await createPaymentDocument({
      orgId: user.orgId,
      kind: body.kind,
      createdBy: user.id,
    })
    return NextResponse.json(doc)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
