import { NextResponse } from 'next/server'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import { guardLienWaiverFeature, lienWaiverPrintData, loadLienWaiverPrintSource } from '@/lib/compliance'
import { renderLienWaiverPdf } from '@/lib/lien-waiver-pdf'
import { isLienWaiverExecutedSnapshot } from '@/lib/lien-waiver-form'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * The printable waiver. Prints as a blank to be executed while the waiver is
 * unsigned and as the executed release once it is signed — but the executed
 * print serves the image frozen at signing (executed_snapshot), never the
 * live rows: renaming a vendor or rewording a project after execution must
 * not rewrite the release the signatory signed. Waivers executed before the
 * freeze existed carry no image and still render live; a present-but-corrupt
 * image fails closed instead of silently falling back to live rows.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('compliance.read')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardLienWaiverFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId } = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const w = await loadLienWaiverPrintSource(orgId, id)
  if (!w) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, w.projectSubsidiaryId)
  if (denied) return denied

  let data: ReturnType<typeof lienWaiverPrintData>['data']
  let orgName: string
  let filename: string
  if (w.executedSnapshot !== null && w.executedSnapshot !== undefined) {
    if (!isLienWaiverExecutedSnapshot(w.executedSnapshot)) {
      return NextResponse.json({ error: 'the executed print image is corrupt — void and reissue this waiver' }, { status: 500 })
    }
    data = w.executedSnapshot.data
    orgName = w.executedSnapshot.orgName
    filename = data.waiverNumber
  } else {
    const live = lienWaiverPrintData(w)
    data = live.data
    orgName = live.orgName
    filename = w.waiverNumber
  }

  const pdf = await renderLienWaiverPdf(data, orgName)

  const body = new Uint8Array(pdf)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${filename}.pdf"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
