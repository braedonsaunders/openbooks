import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { createPaymentDocument } from "@openbooks/engine/src/payments/payment-documents.ts";
import { can, getAuthz, guardPermission } from '../../../../lib/authz'
import { parseJsonBody } from '../../../../lib/api/json'
import { paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

const draftBody = z.object({
  kind: z.enum(['vendor_payment', 'customer_payment'], {
    error: 'kind must be vendor_payment or customer_payment',
  }),
})

/** Instant-into-draft: create an empty draft payment/receipt, return its id. */
async function createPaymentDraft(req: Request) {
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
      // A restricted caller defaults to their own subsidiary, or a named
      // refusal — never the org root.
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    })
    return NextResponse.json(doc)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}

export const POST = defineRoute({
  authorize: async ({ request }) => {
    let kind: unknown
    try { kind = (await request.clone().json() as { kind?: unknown }).kind } catch { /* body parser handles malformed JSON below */ }
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if ((kind === 'vendor_payment' || kind === 'customer_payment') && !can(authz, paymentPermission(kind))) {
      return NextResponse.json({ error: `missing permission: ${paymentPermission(kind)}` }, { status: 403 })
    }
    return authz
  },
  feature: { none: 'Draft payment permission is selected from the validated payment kind.' },
  handler: async ({ request }) => createPaymentDraft(request),
})
