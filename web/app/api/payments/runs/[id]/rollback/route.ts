import { NextResponse } from 'next/server'
import { rollbackPaymentRun } from '@openbooks/engine/src/payment-operations.ts'
import { guardPermission } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as { reason?: string }
  try { await rollbackPaymentRun(id, gate.user.orgId, gate.user.id, body.reason ?? ''); return NextResponse.json({ ok: true }) }
  catch (e) { return paymentErrorResponse(e) }
}
