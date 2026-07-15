import { NextResponse } from 'next/server'
import { getFileBlob } from '../../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../../lib/list-params'
import { guardPermission } from '../../../../../../lib/authz'
import { fileViewer } from '../../../lib'

export const runtime = 'nodejs'

/**
 * Stream a file's bytes. Content-Disposition is `inline` (view PDFs and
 * images in the browser) and `X-Content-Type-Options: nosniff` prevents the
 * browser from re-interpreting the bytes as a different, executable type.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const url = new URL(req.url)
  const versionId = url.searchParams.get('versionId') ?? undefined
  if (versionId && !isUuid(versionId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const blob = await getFileBlob(gate.user.orgId, id, fileViewer(gate), versionId)
  if (!blob) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Header-safe filename: strip control chars (header injection), quotes and
  // backslashes (quoted-string escapes), and non-ASCII (invalid in header
  // values). The original UTF-8 name is carried in RFC 5987 `filename*`.
  const asciiName =
    blob.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'file'
  const utf8Name = encodeURIComponent(blob.filename)

  const body = new Uint8Array(blob.bytes)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': blob.contentType,
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
