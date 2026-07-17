import { NextResponse } from 'next/server'
import { createDirectDebitRun } from '@openbooks/engine/src/direct-debit.ts'
import { guardPermission } from '@/lib/authz'
import { paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const gate = await guardPermission('ar.pay')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json()) as { paymentBankProfileId?: string; invoiceDocumentIds?: string[]; scheduledFor?: string | null }
  if (!body.paymentBankProfileId || !Array.isArray(body.invoiceDocumentIds) || body.invoiceDocumentIds.length === 0) {
    return NextResponse.json({ error: 'A profile and at least one invoice are required' }, { status: 400 })
  }
  try {
    return NextResponse.json(await createDirectDebitRun({
      orgId: gate.user.orgId,
      createdBy: gate.user.id,
      paymentBankProfileId: body.paymentBankProfileId,
      invoiceDocumentIds: body.invoiceDocumentIds,
      scheduledFor: body.scheduledFor ?? null,
    }))
  } catch (error) {
    return paymentErrorResponse(error)
  }
}
