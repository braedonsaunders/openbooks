import { NextResponse } from 'next/server'
import { postPaymentRun } from '@openbooks/engine/src/payments.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { guardPaymentRunPermission, paymentErrorResponse } from '../../../lib'

export const runtime = 'nodejs'

/**
 * Explicit second step after the EFT file export: post every instruction's
 * vendor_payment document + applications. Partial failures are reported and
 * leave the run 'exported' so the failed instructions can be retried.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate

  try {
    const result = await postPaymentRun(id, gate.user.orgId, gate.user.id)
    return NextResponse.json({ ok: result.failures.length === 0, ...result })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
