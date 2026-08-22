import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { mergedRunChequesPdf } from '../../../../../../lib/payroll-outputs'
import { pdfResponse, safeName } from '../../../../../../lib/export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST — the run's cheque batch as one printable PDF.
 *
 * POST rather than GET because printing ALLOCATES cheque numbers off the org's
 * number sequence the first time: consuming stock is not a safe response to a
 * link preview or a browser prefetch. It is idempotent thereafter — a reprint
 * returns the same numbers — and needs `payroll.run`, not `payroll.read`,
 * because it produces negotiable instruments.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const merged = await mergedRunChequesPdf(gate.user.orgId, id, gate.user.id)
    if (!merged) return NextResponse.json({ error: 'no cheques to print' }, { status: 404 })
    const stamp = await businessToday(gate.user.orgId)
    return pdfResponse(Buffer.from(merged.pdf), safeName(`Pay-cheques-${id.slice(0, 8)}-${stamp}`))
  } catch (error) {
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    throw error
  }
}
