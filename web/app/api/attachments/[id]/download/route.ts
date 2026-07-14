import { NextResponse } from 'next/server'
import { getBlob } from '../../../../../lib/attachments'
import { isUuid } from '../../../../../lib/list-params'
import { requireSession } from '../../lib'

export const runtime = 'nodejs'

/**
 * Stream an attachment's bytes. Content-Disposition is `inline` (view PDFs and
 * images in the browser) and `X-Content-Type-Options: nosniff` prevents the
 * browser from re-interpreting the bytes as a different, executable type.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const blob = await getBlob(gate.user.orgId, id)
  if (!blob) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = new Uint8Array(blob.bytes)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': blob.contentType,
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${blob.filename.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
