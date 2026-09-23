import { NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveUncertainDelivery } from '@openbooks/engine/src/payments/operations.ts'
import { isUuid } from '@/lib/list-params'
import { parseJsonBody } from '@/lib/api/json'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

const resolveDeliveryBody = z.object({
  outcome: z.enum(['delivered', 'approved'], { error: 'outcome must be delivered or approved' }),
  reason: z.string().trim().min(1, 'a resolution reason is required'),
})

/**
 * Resolve a delivery_uncertain file: confirm the bank has the bytes
 * (delivered, recording delivery evidence) or release it back to approved
 * for a careful re-delivery (only after verifying with the bank that
 * nothing arrived). Approval-grade permission; the decision and its reason
 * are audited on the file's event trail by the engine.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params
  if (!isUuid(id) || !isUuid(fileId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id, 'approve')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, resolveDeliveryBody)
  if (!parsed.ok) return parsed.response
  try {
    await resolveUncertainDelivery({
      fileId,
      orgId: gate.user.orgId,
      userId: gate.user.id,
      outcome: parsed.data.outcome,
      reason: parsed.data.reason,
      runId: id,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
