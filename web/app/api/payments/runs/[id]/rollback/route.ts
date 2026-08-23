import { NextResponse } from 'next/server'
import { z } from 'zod'
import { rollbackPaymentRun } from '@openbooks/engine/src/payment-operations.ts'
import { isUuid } from '@/lib/list-params'
import { parseJsonBody } from '@/lib/api/json'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

const rollbackBody = z.object({
  reason: z.string().default(''),
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, rollbackBody)
  if (!parsed.ok) return parsed.response
  try { await rollbackPaymentRun(id, gate.user.orgId, gate.user.id, parsed.data.reason); return NextResponse.json({ ok: true }) }
  catch (e) { return paymentErrorResponse(e) }
}
