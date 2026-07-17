import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { recordPaymentSettlement } from '@openbooks/engine/src/payment-operations.ts'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

export async function POST(req: Request, { params }: { params: Promise<{ id: string; instructionId: string }> }) {
  const { id, instructionId } = await params
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  const owned = (await db.execute(sql`
    select 1 from payment_instructions i join payment_runs r on r.id = i.payment_run_id
     where i.id = ${instructionId} and r.id = ${id} and r.org_id = ${gate.user.orgId}
  `)) as unknown as { rows: unknown[] }
  if (!owned.rows[0]) return NextResponse.json({ error: 'Payment instruction not found' }, { status: 404 })
  const body = (await req.json()) as {
    status?: 'settled' | 'returned' | 'rejected'
    effectiveOn?: string
    bankReference?: string | null
    returnCode?: string | null
    returnReason?: string | null
  }
  if (!body.status || !['settled', 'returned', 'rejected'].includes(body.status)) {
    return NextResponse.json({ error: 'A valid outcome is required' }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveOn ?? '')) {
    return NextResponse.json({ error: 'A valid effective date is required' }, { status: 400 })
  }
  if (body.status !== 'settled' && !body.returnReason?.trim()) {
    return NextResponse.json({ error: 'A return reason is required' }, { status: 400 })
  }
  try {
    await recordPaymentSettlement({
      instructionId,
      orgId: gate.user.orgId,
      userId: gate.user.id,
      status: body.status,
      effectiveOn: body.effectiveOn!,
      bankReference: body.bankReference ?? null,
      returnCode: body.returnCode ?? null,
      returnReason: body.returnReason ?? null,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return paymentErrorResponse(error)
  }
}
