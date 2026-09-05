import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/db.ts'
import { recordPaymentSettlement } from '@openbooks/engine/src/payment-operations.ts'
import { isoDate, parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'
import { guardPaymentRunPermission, paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

const settlementBody = z
  .object({
    status: z.enum(['settled', 'returned', 'rejected'], { error: 'A valid outcome is required' }),
    effectiveOn: isoDate('A valid effective date is required'),
    bankReference: z.string().nullable().optional(),
    returnCode: z.string().nullable().optional(),
    returnReason: z.string().nullable().optional(),
  })
  .refine((body) => body.status === 'settled' || !!body.returnReason?.trim(), {
    error: 'A return reason is required',
  })

export async function POST(req: Request, { params }: { params: Promise<{ id: string; instructionId: string }> }) {
  const { id, instructionId } = await params
  if (!isUuid(id) || !isUuid(instructionId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  const owned = (await db.execute(sql`
    select 1 from payment_instructions i join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
     where i.id = ${instructionId} and r.id = ${id} and r.org_id = ${gate.user.orgId}
  `))
  if (!owned.rows[0]) return NextResponse.json({ error: 'Payment instruction not found' }, { status: 404 })
  const parsed = await parseJsonBody(req, settlementBody)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  try {
    await recordPaymentSettlement({
      instructionId,
      orgId: gate.user.orgId,
      userId: gate.user.id,
      status: body.status,
      effectiveOn: body.effectiveOn,
      bankReference: body.bankReference ?? null,
      returnCode: body.returnCode ?? null,
      returnReason: body.returnReason ?? null,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return paymentErrorResponse(error)
  }
}
