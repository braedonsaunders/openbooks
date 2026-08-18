import { NextResponse } from 'next/server'
import { filingArtifact } from '@openbooks/engine/src/payroll-yearend-amendments.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

/**
 * GET ?id= — the EXACT bytes of one issued artifact.
 *
 * This is the audit trail's whole point: whatever has since superseded it,
 * what went to the agency is retrievable unchanged. Nothing regenerates here —
 * the response is the stored transmission, byte for byte.
 *
 * Wage data, so payroll.read; scoped to the caller's org by the query itself.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'a submission id is required' }, { status: 422 })
  }
  const file = await filingArtifact(gate.user.orgId, id)
  if (!file) {
    return NextResponse.json(
      { error: 'that filing was recorded without an electronic file — the slip snapshots on the filing history are its record' },
      { status: 404 },
    )
  }
  return new NextResponse(file.body, {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    },
  })
}
