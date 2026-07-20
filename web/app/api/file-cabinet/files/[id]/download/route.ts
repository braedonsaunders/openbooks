import { NextResponse } from 'next/server'
import { getFileBlob } from '../../../../../../lib/file-cabinet'
import { blobResponse } from '../../../../../../lib/blob-response'
import { isUuid } from '../../../../../../lib/list-params'
import { guardPermission } from '../../../../../../lib/authz'
import { fileViewer } from '../../../lib'

export const runtime = 'nodejs'

/**
 * Stream a file's bytes (inline, cache-revalidated — see blobResponse). A pinned
 * `?versionId=` is immutable and cached hard; the current-version URL uses ETag
 * revalidation so reopening a flyout is a 304, not a re-download.
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

  return blobResponse(req, blob, { immutable: versionId != null })
}
