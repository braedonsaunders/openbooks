import { NextResponse } from 'next/server'
import { z } from 'zod'
import { decidePaymentFile } from '@openbooks/engine/src/payment-operations.ts'
import { isUuid } from '@/lib/list-params'
import { parseJsonBody } from '@/lib/api/json'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

const fileDecisionBody = z.object({
  decision: z.enum(['approve', 'reject'], { error: 'invalid decision' }),
  reason: z.string().optional(),
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params
  if (!isUuid(id) || !isUuid(fileId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id, 'approve')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, fileDecisionBody)
  if (!parsed.ok) return parsed.response
  try { await decidePaymentFile(fileId, gate.user.orgId, gate.user.id, parsed.data.decision, parsed.data.reason, { runId: id }); return NextResponse.json({ ok: true }) }
  catch (e) { return paymentErrorResponse(e) }
}
