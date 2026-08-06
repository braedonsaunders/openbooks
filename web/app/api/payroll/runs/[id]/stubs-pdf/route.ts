import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { mergedRunStubsPdf } from '../../../../../../lib/payroll-outputs'
import { pdfResponse, safeName } from '../../../../../../lib/export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET — every stub in the run as one printable PDF (employee order). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const merged = await mergedRunStubsPdf(gate.user.orgId, id)
  if (!merged) return NextResponse.json({ error: 'no stubs to print' }, { status: 404 })
  return pdfResponse(Buffer.from(merged.pdf), safeName(`Pay-stubs-${id.slice(0, 8)}`))
}
