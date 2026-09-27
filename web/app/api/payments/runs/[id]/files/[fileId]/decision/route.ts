import { NextResponse } from 'next/server'
import { defineRoute } from "@/lib/api/route";
import { z } from 'zod'
import { decidePaymentFile } from '@openbooks/engine/src/payments/operations.ts'
import { isUuid } from '@/lib/list-params'
import { parseJsonBody } from '@/lib/api/json'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const fileDecisionBody = z.object({
  decision: z.enum(['approve', 'reject'], { error: 'invalid decision' }),
  reason: z.string().optional(),
})

async function legacyPOST(req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params
  if (!isUuid(id) || !isUuid(fileId)) return notFound("record")
  const gate = await guardPaymentRunPermission(id, 'approve')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, fileDecisionBody)
  if (!parsed.ok) return parsed.response
  try { await decidePaymentFile(fileId, gate.user.orgId, gate.user.id, parsed.data.decision, parsed.data.reason, { runId: id }); return NextResponse.json({ ok: true }) }
  catch (e) { return paymentErrorResponse(e) }
}

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const runId = String((params as { id?: string } | undefined)?.id ?? "");
    return guardPaymentRunPermission(runId, "approve");
  },
  feature: { none: "Payment-run authorization checks the run direction, capability, and subsidiary scope." },
  handler: async ({ request, params }) => legacyPOST(request, { params: Promise.resolve(params as never) }),
});
