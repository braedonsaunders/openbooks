import { NextResponse } from 'next/server'
import { defineRoute } from "@/lib/api/route";
import { postPaymentRun } from "@openbooks/engine/src/payments/run-posting.ts";
import { isUuid } from '../../../../../../lib/list-params'
import { guardPaymentRunPermission, paymentErrorResponse } from '../../../lib'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/**
 * Explicit second step after the EFT file export: post every instruction's
 * vendor_payment document + applications. Partial failures are reported and
 * leave the run 'exported' so the failed instructions can be retried.
 */
async function legacyPOST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate

  try {
    const result = await postPaymentRun(id, gate.user.orgId, gate.user.id)
    return NextResponse.json({ ok: result.failures.length === 0, ...result })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const runId = String((params as { id?: string } | undefined)?.id ?? "");
    return guardPaymentRunPermission(runId);
  },
  feature: { none: "Payment-run authorization checks the run direction, capability, and subsidiary scope." },
  handler: async ({ request, params }) => legacyPOST(request, { params: Promise.resolve(params as never) }),
});
