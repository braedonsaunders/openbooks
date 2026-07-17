import { NextResponse } from 'next/server'
import { decidePaymentRun } from '@openbooks/engine/src/payment-operations.ts'
import { guardPermission } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.approve')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as { decision?: string; reason?: string }
  if (body.decision !== 'approve' && body.decision !== 'reject') return NextResponse.json({ error: 'invalid decision' }, { status: 400 })
  try { await decidePaymentRun(id, gate.user.orgId, gate.user.id, body.decision, body.reason); return NextResponse.json({ ok: true }) }
  catch (e) { return paymentErrorResponse(e) }
}
