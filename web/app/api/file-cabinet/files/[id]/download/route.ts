import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getFileBlob } from '../../../../../../lib/file-cabinet'
import { blobResponse } from '../../../../../../lib/blob-response'
import { isUuid } from '../../../../../../lib/list-params'
import { can, getAuthz } from '../../../../../../lib/authz'
import { fileViewer } from '../../../lib'

export const runtime = 'nodejs'

/**
 * Stream a file's bytes (inline, cache-revalidated — see blobResponse). A pinned
 * `?versionId=` is immutable and cached hard; the current-version URL uses ETag
 * revalidation so reopening a flyout is a 304, not a re-download.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await getAuthz()
  if (!gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let viewer = fileViewer(gate)
  if (!can(gate, 'documents.read')) {
    if (!can(gate, 'assets.read')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    const attachedAsset = (await db.execute(sql`
      select 1
        from file_attachments fa
        join fixed_assets a on a.id=fa.target_id and a.org_id=fa.org_id
       where fa.org_id=${gate.user.orgId}
         and fa.file_id=${id}
         and fa.target_table='fixed_assets'
         ${gate.allowedSubsidiaryIds
           ? sql`and a.subsidiary_id=any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])`
           : sql``}
       limit 1
    `))
    if (!attachedAsset.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // The attachment relation above limits this exception to evidence on an
    // asset the caller can see; it does not grant cabinet-wide visibility.
    viewer = { userId: gate.user.id, isAdmin: can(gate, '*'), baseline: 'viewer' }
  }

  const url = new URL(req.url)
  const versionId = url.searchParams.get('versionId') ?? undefined
  if (versionId && !isUuid(versionId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const blob = await getFileBlob(gate.user.orgId, id, viewer, versionId)
  if (!blob) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return blobResponse(req, blob, { immutable: versionId != null })
}
