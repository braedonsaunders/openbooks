import { NextResponse } from 'next/server'
import { z } from 'zod'
import { decidePaymentRun } from '@openbooks/engine/src/payment-operations.ts'
import { isUuid } from '@/lib/list-params'
import { parseJsonBody } from '@/lib/api/json'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

const runDecisionBody = z.object({
  decision: z.enum(['approve', 'reject'], { error: 'invalid decision' }),
  reason: z.string().optional(),
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id, 'approve')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, runDecisionBody)
  if (!parsed.ok) return parsed.response
  try { await decidePaymentRun(id, gate.user.orgId, gate.user.id, parsed.data.decision, parsed.data.reason); return NextResponse.json({ ok: true }) }
  catch (e) { return paymentErrorResponse(e) }
}
