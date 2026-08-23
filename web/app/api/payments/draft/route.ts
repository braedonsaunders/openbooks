import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createPaymentDocument } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../lib/authz'
import { parseJsonBody } from '../../../../lib/api/json'
import { paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

const draftBody = z.object({
  kind: z.enum(['vendor_payment', 'customer_payment'], {
    error: 'kind must be vendor_payment or customer_payment',
  }),
})

/** Instant-into-draft: create an empty draft payment/receipt, return its id. */
export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, draftBody)
  if (!parsed.ok) return parsed.response
  const kind = parsed.data.kind
  const gate = await guardPermission(paymentPermission(kind))
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  try {
    const doc = await createPaymentDocument({
      orgId: user.orgId,
      kind,
      createdBy: user.id,
    })
    return NextResponse.json(doc)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
