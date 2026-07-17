import { NextResponse } from 'next/server'
import { generatePaymentFileArtifact } from '@openbooks/engine/src/payment-operations.ts'
import { guardPermission } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate
  const { id, fileId } = await params
  if (!isUuid(id) || !isUuid(fileId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try { const file = await generatePaymentFileArtifact(id, gate.user.orgId, gate.user.id, { reprocessFileId: fileId }); return NextResponse.json({ id: file.id, filename: file.filename }) }
  catch (e) { return paymentErrorResponse(e) }
}
