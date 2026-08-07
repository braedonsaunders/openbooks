import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { mergedRunStubsPdf } from '../../../../../../lib/payroll-outputs'
import { pdfResponse, safeName } from '../../../../../../lib/export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET — the run's stubs as one printable PDF (employee order).
 * `?set=print` returns the PRINT SET: only the employees whose stub delivery
 * is print or both, which is what actually goes to the printer once the
 * emailed stubs have gone out.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const set = new URL(req.url).searchParams.get('set') === 'print' ? 'print' : 'all'
  const merged = await mergedRunStubsPdf(gate.user.orgId, id, { set })
  if (!merged) return NextResponse.json({ error: 'no stubs to print' }, { status: 404 })
  return pdfResponse(
    Buffer.from(merged.pdf),
    safeName(`Pay-stubs${set === 'print' ? '-print-set' : ''}-${id.slice(0, 8)}`),
  )
}
