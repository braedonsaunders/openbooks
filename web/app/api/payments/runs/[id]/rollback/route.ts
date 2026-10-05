import { NextResponse } from 'next/server'
import { defineRoute } from "@/lib/api/route";
import { z } from 'zod'
import { rollbackPaymentRun } from '@openbooks/engine/src/payments/operations.ts'
import { isUuid } from '@/lib/list-params'
import { parseJsonBody } from '@/lib/api/json'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const rollbackBody = z.object({
  reason: z.string().default(''),
  /** The run number typed back to attest the bank did not process a delivered file. */
  bankNotProcessedAttestation: z.string().optional(),
})

async function legacyPOST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, rollbackBody)
  if (!parsed.ok) return parsed.response
  try { await rollbackPaymentRun(id, gate.user.orgId, gate.user.id, parsed.data.reason, { bankNotProcessedAttestation: parsed.data.bankNotProcessedAttestation ?? null }); return NextResponse.json({ ok: true }) }
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
