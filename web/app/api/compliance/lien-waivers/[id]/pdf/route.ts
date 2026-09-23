import { NextResponse } from 'next/server'
import { rendererUnavailableResponse } from '@/lib/api/pdf-renderer'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import {
  guardLienWaiverFeature,
  isLienWaiverLegacyUnverified,
  legacyLienWaiverFilename,
  lienWaiverPrintData,
  loadLienWaiverPrintSource,
} from '@/lib/compliance'
import { renderLienWaiverPdf } from '@/lib/lien-waiver-pdf'
import { isLienWaiverExecutedSnapshot } from '@/lib/lien-waiver-form'
import { isUuid } from '@/lib/list-params'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'

export const runtime = 'nodejs'

/**
 * The printable waiver. Prints as a blank to be executed while the waiver is
 * unsigned and as the executed release once it is signed — but the executed
 * print serves the image frozen at signing (executed_snapshot), never the
 * live rows: renaming a vendor or rewording a project after execution must
 * not rewrite the release the signatory signed. Waivers executed before the
 * freeze existed carry no image and must never be presented as the release:
 * they render the live rows under a prominent legacy banner naming them as
 * current records as of today, with a distinct filename and evidence header.
 * A present-but-corrupt image fails closed instead of silently falling back
 * to live rows.
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
  let legacyAsOf: string | null = null
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
    // A legacy executed waiver has no frozen image to serve. Refusing to
    // print would strand the operator, and printing the live rows bare would
    // present them AS the executed release — so print them bannered as
    // current records, under a filename no one files as the release.
    if (
      await isLienWaiverLegacyUnverified(orgId, {
        id,
        status: w.status,
        signedAt: w.signedAt,
        hasExecutedSnapshot: false,
      })
    ) {
      legacyAsOf = await businessToday(orgId)
      filename = legacyLienWaiverFilename(w.waiverNumber)
    } else {
      filename = w.waiverNumber
    }
  }

  let pdf: Buffer
  try {
    pdf = await renderLienWaiverPdf(
      data,
      orgName,
      legacyAsOf ? { legacyUnverifiedAsOf: legacyAsOf } : undefined,
    )
  } catch (e) {
    const rendererRefusal = rendererUnavailableResponse(e)
    if (rendererRefusal) return rendererRefusal
    throw e
  }

  const body = new Uint8Array(pdf)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${filename}.pdf"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      ...(legacyAsOf ? { 'X-Lien-Waiver-Evidence': 'legacy-unverified' } : {}),
    },
  })
}
