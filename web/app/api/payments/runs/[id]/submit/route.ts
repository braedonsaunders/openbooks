import { NextResponse } from 'next/server'
import { defineRoute } from "@/lib/api/route";
import { submitPaymentRun } from '@openbooks/engine/src/payments/operations.ts'
import { isUuid } from '@/lib/list-params'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'
async function legacyPOST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  // `gated` tells the caller whether an approval flow now holds the run or,
  // with none configured, it was released to approved on submit.
  try {
    const submitted = await submitPaymentRun(id, gate.user.orgId, gate.user.id)
    return NextResponse.json({ ok: true, status: submitted.status, gated: submitted.gated })
  }
  catch (e) { return paymentErrorResponse(e) }
}

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const runId = String((params as { id?: string } | undefined)?.id ?? "");
    return guardPaymentRunPermission(runId);
  },
  feature: { none: "Payment-run authorization checks the run direction, capability, and subsidiary scope." },
  handler: async ({ request, params }) => legacyPOST(request, { params: Promise.resolve(params as never) }),
});
